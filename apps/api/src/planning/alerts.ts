/**
 * Price-drop alerts (spec §9 phase 3). Run by the Cron Trigger: re-checks a
 * few saved trips per run with fresh provider calls, and when the cheapest
 * package has dropped enough below the best price seen, records an alert and
 * emails it through Resend.
 */
import { formatMoney } from "@tagalong/shared";
import { newId, nowIso } from "../lib/http.js";
import { WEB_ORIGIN } from "../lib/share.js";
import { sendEmail } from "../providers/resend.js";
import { runPlan } from "./run.js";
import { cheapestTotal } from "./view.js";

/** Re-check a saved trip at most this often. */
export const RECHECK_EVERY_MS = 12 * 3600 * 1000;
/** Trips re-checked per cron run: bounds provider spend and run time. */
export const TRIPS_PER_RUN = 5;
/** A drop smaller than this share of the price is noise, not news. */
export const ALERT_MIN_DROP_RATE = 0.02;

interface DueTrip {
	user_id: string;
	trip_request_id: string;
	latest_plan_id: string;
	best_total_minor: number | null;
	currency: string;
	email: string;
	event_name: string | null;
	event_query: string;
}

const escapeHtml = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
	);

export function isAlertWorthy(best: number | null, now: number | null): boolean {
	if (best === null || now === null) return false;
	return now < best && best - now >= Math.ceil(best * ALERT_MIN_DROP_RATE);
}

export async function checkSavedTrips(
	env: Env,
	now = new Date(),
): Promise<{ checked: number; alerts: number }> {
	const db = env.DB;
	const cutoff = new Date(now.getTime() - RECHECK_EVERY_MS).toISOString();
	const today = now.toISOString().slice(0, 10);
	const { results: due } = await db
		.prepare(
			`SELECT s.user_id, s.trip_request_id, s.latest_plan_id, s.best_total_minor, s.currency,
			   u.email, e.name AS event_name, t.event_query
			 FROM saved_trips s
			 JOIN users u ON u.id = s.user_id
			 JOIN trip_requests t ON t.id = s.trip_request_id
			 JOIN plans p ON p.id = s.latest_plan_id
			 LEFT JOIN events e ON e.id = p.event_id
			 WHERE s.alerts_enabled = 1
			   AND (s.last_checked_at IS NULL OR s.last_checked_at < ?)
			   AND COALESCE(e.local_date, t.date_to) >= ?
			 ORDER BY s.last_checked_at IS NOT NULL, s.last_checked_at
			 LIMIT ?`,
		)
		.bind(cutoff, today, TRIPS_PER_RUN)
		.all<DueTrip>();

	let alerts = 0;
	for (const trip of due) {
		// Mark first: a run that fails part-way must not re-check the same trip every cron tick.
		await db
			.prepare(
				"UPDATE saved_trips SET last_checked_at = ? WHERE user_id = ? AND trip_request_id = ?",
			)
			.bind(nowIso(), trip.user_id, trip.trip_request_id)
			.run();

		const planId = newId();
		await db
			.prepare(
				`INSERT INTO plans (id, user_id, trip_request_id, status, progress, rechecked_from)
				 VALUES (?, ?, ?, 'queued', 'Scheduled price check…', ?)`,
			)
			.bind(planId, trip.user_id, trip.trip_request_id, trip.latest_plan_id)
			.run();
		await runPlan(env, planId, { fresh: true });

		const status = await db
			.prepare("SELECT status FROM plans WHERE id = ?")
			.bind(planId)
			.first<{ status: string }>();
		if (status?.status !== "done") continue;
		const latest = await cheapestTotal(db, planId);

		await db
			.prepare(
				`UPDATE saved_trips SET latest_plan_id = ?,
				   best_total_minor = CASE WHEN best_total_minor IS NULL THEN ?
				     WHEN ? IS NULL THEN best_total_minor ELSE MIN(best_total_minor, ?) END
				 WHERE user_id = ? AND trip_request_id = ?`,
			)
			.bind(planId, latest, latest, latest, trip.user_id, trip.trip_request_id)
			.run();

		if (
			!isAlertWorthy(trip.best_total_minor, latest) ||
			latest === null ||
			trip.best_total_minor === null
		)
			continue;

		const alertId = newId();
		await db
			.prepare(
				`INSERT INTO price_alerts (id, user_id, trip_request_id, plan_id, old_total_minor, new_total_minor, currency)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				alertId,
				trip.user_id,
				trip.trip_request_id,
				planId,
				trip.best_total_minor,
				latest,
				trip.currency,
			)
			.run();
		alerts++;

		if (!env.RESEND_API_KEY) continue; // recorded and shown in the app; no email until the key is set
		const name = trip.event_name ?? trip.event_query;
		const was = formatMoney({ amount_minor: trip.best_total_minor, currency: trip.currency });
		const nowPrice = formatMoney({ amount_minor: latest, currency: trip.currency });
		const link = `${WEB_ORIGIN}/plans/${planId}`;
		const tripsLink = `${WEB_ORIGIN}/trips`;
		try {
			await sendEmail(env.RESEND_API_KEY, {
				from: env.ALERT_FROM_EMAIL,
				to: trip.email,
				subject: `Price drop: ${name} now from ${nowPrice}`,
				text: `Good news: your saved trip to ${name} now starts at ${nowPrice}, down from ${was}.\n\nSee the packages: ${link}\n\nPrices change; check them when you book. Turn these emails off under My trips: ${tripsLink}`,
				html: `<p>Good news: your saved trip to <strong>${escapeHtml(name)}</strong> now starts at <strong>${escapeHtml(nowPrice)}</strong>, down from ${escapeHtml(was)}.</p><p><a href="${link}">See the packages</a></p><p style="color:#64748b;font-size:13px">Prices change; check them when you book. Turn these emails off under <a href="${tripsLink}">My trips</a>.</p>`,
			});
			await db
				.prepare("UPDATE price_alerts SET emailed_at = ? WHERE id = ?")
				.bind(nowIso(), alertId)
				.run();
		} catch (err) {
			console.warn("price alert email failed", alertId, err);
			await db
				.prepare("UPDATE price_alerts SET email_error = ? WHERE id = ?")
				.bind(err instanceof Error ? err.message.slice(0, 200) : "send failed", alertId)
				.run();
		}
	}
	return { checked: due.length, alerts };
}
