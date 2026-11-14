/**
 * Events Tagalong sends Jarvis (Jarvis events contract v1, defined in Jarvis
 * `docs/EVENTS.md`) over the `JARVIS_EVENTS` Cloudflare Queue. See
 * docs/SETUP.md "Jarvis events".
 *
 * Only `tagalong.price_drop`, sent when the scheduled re-check records a
 * `price_alerts` row. It goes only to users Jarvis may already read (the same
 * JARVIS_READ_EMAILS + one live Google account rule as JarvisReadApi), and it
 * carries only what the read API already exposes for that trip plus the
 * alert's old and new totals.
 *
 * Money comes straight from the stored price_alerts row: never recomputed,
 * never converted, never from AI. `isEstimate` and `asOf` come from the stored
 * cheapest package the alert's total refers to, read exactly as the read API
 * reads it; when that package's total or currency doesn't match the alert, no
 * event is sent rather than a guessed one.
 *
 * Sending never throws: a failure is logged by error name only (no message,
 * so no email, trip or provider text can reach the logs) and the price check,
 * push and email go on. Without the binding, or for an owner whose address
 * isn't on the allowlist, it is a no-op without a DB read.
 */
import {
	CHEAPEST_SQL,
	clipText,
	isRealDate,
	jarvisUserForEmail,
	MAX_AMOUNT_MINOR,
	MAX_TITLE,
	parseAllowlist,
	toCheapest,
	type CheapestRow,
} from "./jarvis-read.js";

export const JARVIS_EVENTS_CONTRACT_VERSION = 1;
/** Jarvis drops any message larger than this. */
export const MAX_EVENT_BYTES = 4096;
export const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface JarvisMoney {
	amountMinor: number;
	currency: string;
}

export interface JarvisPriceDropEvent {
	app: "tagalong";
	contractVersion: typeof JARVIS_EVENTS_CONTRACT_VERSION;
	eventId: string;
	type: "tagalong.price_drop";
	userEmail: string;
	occurredAt: string;
	payload: {
		tripTitle: string;
		tripDate: string;
		was: JarvisMoney;
		now: JarvisMoney & { isEstimate: boolean; asOf: string };
	};
}

export type JarvisEvent = JarvisPriceDropEvent;

/** The error's name only: a message may carry an address or provider text. */
const errName = (err: unknown) => (err instanceof Error ? err.name : "unknown error");

/**
 * Queues one event for Jarvis. True when it was handed to the queue. Never
 * throws; no-op (false) when the JARVIS_EVENTS binding is absent or the
 * message is over MAX_EVENT_BYTES.
 */
export async function sendJarvisEvent(env: Env, event: JarvisEvent): Promise<boolean> {
	const queue = (env as Partial<Env>).JARVIS_EVENTS;
	if (!queue) return false;
	try {
		if (new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_EVENT_BYTES) {
			console.warn("jarvis event too large; not sent", event.type);
			return false;
		}
		await queue.send(event, { contentType: "json" });
		return true;
	} catch (err) {
		console.warn("jarvis event send failed", event.type, errName(err));
		return false;
	}
}

/** `2026-11-14T09:30:00Z`: whole seconds, UTC. Null when not a date. */
export function isoSeconds(value: string): string | null {
	const t = Date.parse(value);
	if (Number.isNaN(t)) return null;
	return new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

const isMinor = (n: unknown): n is number =>
	typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_AMOUNT_MINOR;

interface AlertRow {
	id: string;
	user_id: string;
	plan_id: string;
	old_total_minor: number;
	new_total_minor: number;
	currency: string;
	created_at: string;
	email: string | null;
	event_name: string | null;
	event_query: string | null;
	trip_date: string | null;
}

/**
 * The `tagalong.price_drop` event for one stored price_alerts row, or null
 * when it must not (or cannot honestly) be sent: the owner isn't on the
 * Jarvis allowlist with one live Google account, the trip isn't saved with
 * alerts on, or a stored value is outside the contract.
 */
export async function buildPriceDropEvent(
	env: Env,
	alertId: string,
	userId: string,
): Promise<JarvisPriceDropEvent | null> {
	const eventId = `pd_${alertId}`;
	if (!EVENT_ID_RE.test(eventId)) return null;

	const alert = await env.DB.prepare(
		`SELECT a.id, a.user_id, a.plan_id, a.old_total_minor, a.new_total_minor, a.currency,
		   a.created_at, u.email, e.name AS event_name, t.event_query,
		   COALESCE(e.local_date, t.date_from) AS trip_date
		 FROM price_alerts a
		 JOIN users u ON u.id = a.user_id AND u.deleted_at IS NULL
		 JOIN trip_requests t ON t.id = a.trip_request_id AND t.user_id = a.user_id
		 JOIN saved_trips s ON s.user_id = a.user_id AND s.trip_request_id = a.trip_request_id
		   AND s.alerts_enabled = 1
		 JOIN plans p ON p.id = a.plan_id AND p.user_id = a.user_id
		 LEFT JOIN events e ON e.id = p.event_id
		 WHERE a.id = ? AND a.user_id = ?`,
	)
		.bind(alertId, userId)
		.first<AlertRow>();
	if (!alert) return null;

	// Same rule as JarvisReadApi: allowlisted, and exactly one live
	// Google-signed-in account with this address, which is this one.
	const user = await jarvisUserForEmail(env, alert.email);
	if (!user || user.userId !== alert.user_id) return null;

	// new_total_minor and currency are checked below: they must equal the
	// stored cheapest package's, which toCheapest has already validated.
	if (!isMinor(alert.old_total_minor)) return null;
	if (typeof alert.trip_date !== "string" || !isRealDate(alert.trip_date)) return null;
	const occurredAt = isoSeconds(alert.created_at);
	if (!occurredAt) return null;

	const name = typeof alert.event_name === "string" ? clipText(alert.event_name, MAX_TITLE) : "";
	const tripTitle =
		name !== ""
			? name
			: typeof alert.event_query === "string"
				? clipText(alert.event_query, MAX_TITLE)
				: "";
	if (tripTitle === "") return null;

	// isEstimate / asOf: the stored cheapest package of the alert's plan, the
	// one whose total the alert recorded. A mismatch means the rows changed
	// under us: send nothing rather than label the price wrongly.
	const { results } = await env.DB.prepare(CHEAPEST_SQL)
		.bind(alert.plan_id, alert.plan_id, alert.plan_id)
		.all<CheapestRow>();
	const cheapest = toCheapest(results);
	if (
		!cheapest ||
		cheapest.amountMinor !== alert.new_total_minor ||
		cheapest.currency !== alert.currency
	)
		return null;

	return {
		app: "tagalong",
		contractVersion: JARVIS_EVENTS_CONTRACT_VERSION,
		eventId,
		type: "tagalong.price_drop",
		userEmail: user.email,
		occurredAt,
		payload: {
			tripTitle,
			tripDate: alert.trip_date,
			was: { amountMinor: alert.old_total_minor, currency: alert.currency },
			now: {
				amountMinor: alert.new_total_minor,
				currency: alert.currency,
				isEstimate: cheapest.isEstimate,
				asOf: cheapest.asOf,
			},
		},
	};
}

/**
 * Tells Jarvis about a recorded price drop. Never throws, and does nothing
 * (not even a read) without the JARVIS_EVENTS binding, or when the owner's
 * address (`ownerEmail`, as the caller already read it) isn't on the
 * allowlist. buildPriceDropEvent still applies the full jarvisUserForEmail
 * rule to the stored address afterwards.
 */
export async function notifyJarvisPriceDrop(
	env: Env,
	alertId: string,
	userId: string,
	ownerEmail: string | null,
): Promise<void> {
	if (!(env as Partial<Env>).JARVIS_EVENTS || !env.JARVIS_READ_EMAILS) return;
	if (typeof ownerEmail !== "string") return;
	if (!parseAllowlist(env.JARVIS_READ_EMAILS).has(ownerEmail.trim().toLowerCase())) return;
	try {
		const event = await buildPriceDropEvent(env, alertId, userId);
		if (event) await sendJarvisEvent(env, event);
	} catch (err) {
		console.warn("jarvis price-drop event failed", errName(err));
	}
}
