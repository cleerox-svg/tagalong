import type {
	BlockedUser,
	ChatMessage,
	Connection,
	EventCategoryId,
	GroupDetail,
	GroupSummary,
	ModAction,
	ModReport,
	ReportableTargetType,
	ReportReason,
	RoomKind,
	TagalongProfile,
	TagalongStatus,
	EventProvider,
	ParsedTripRequest,
	PinnedEvent,
	Place,
	TripRequest,
	NotificationPrefs,
	NotificationPrefsUpdate,
} from "@tagalong/shared";
import { clearNativeToken, getNativeToken, isNative } from "./native.js";

export const API_BASE = __API_BASE__;

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.body) headers.set("Content-Type", "application/json");
	// The app authenticates with a bearer token and never sends cookies; the
	// browser uses the session cookie as before.
	const native = isNative();
	const token = native ? await getNativeToken() : null;
	if (token) headers.set("Authorization", `Bearer ${token}`);
	const res = await fetch(`${API_BASE}${path}`, {
		...init,
		headers,
		credentials: native ? "omit" : "include",
	});
	if (native && res.status === 401 && token) await clearNativeToken(token);
	const body = (await res.json().catch(() => null)) as {
		error?: { code: string; message: string; details?: unknown };
	} | null;
	if (!res.ok)
		throw new ApiError(
			res.status,
			body?.error?.code ?? "error",
			body?.error?.message ?? `HTTP ${res.status}`,
			body?.error?.details,
		);
	return body as T;
}

export interface Me {
	id: string;
	email: string;
	display_name: string;
	home_city: string | null;
	home_currency: string | null;
	birthdate_verified_18: boolean;
	/** Phase 5. Only the chosen name and city label are ever shown to others. */
	tagalong: TagalongStatus;
	is_moderator: boolean;
}

export interface PlanItem {
	kind: string;
	title: string;
	provider: string;
	amount_minor: number;
	currency: string;
	is_estimate: boolean;
	booking_url: string | null;
	fetched_at: string;
	method: string;
}

export interface PlanPackage {
	id: string;
	rank: number;
	label: "cheapest" | "best_value" | "best_experience" | "weekend" | "alternative";
	total_minor: number;
	currency: string;
	score: number;
	summary_text: string;
	event_name: string;
	local_date: string;
	venue_name: string | null;
	event_city: string | null;
	event_url: string | null;
	details: {
		ticket_tier: string;
		transport_mode: string;
		lodging_type: string;
		nights: number;
		travel_hours: number;
		passport_needed: boolean;
		is_alternative_event: boolean;
	};
	items: PlanItem[];
}

export interface Plan {
	id: string;
	status: "queued" | "running" | "done" | "failed";
	progress: string | null;
	error: string | null;
	created_at: string;
	origin_city: string;
	origin_lat: number;
	origin_lng: number;
	origin_country: string;
	event_query: string;
	requested_event_city: string | null;
	date_from: string;
	date_to: string;
	party_size: number;
	budget_minor: number;
	budget_currency: string;
	budget_scope: "total" | "per_person";
	prefs: TripRequest["prefs"];
	/** The resolved event (owner view); keys the Tagalong group. */
	event_id?: string | null;
	event_name: string | null;
	venue_name: string | null;
	event_city: string | null;
	local_date: string | null;
	event_url: string | null;
	event_fetched_at: string | null;
	result: {
		considered: number;
		within_budget: number;
		budget_total_minor: number;
		currency: string;
		cheapest_over_budget_minor: number | null;
		fx: Array<{ from: string; to: string; rate: number; as_of: string }>;
		estimates: { version: string; as_of: string };
		/** Phase 2: where flight and hotel prices came from. Absent on phase 1 plans. */
		live?: { flights: LiveStatus; hotels: LiveStatus };
		prices_checked_at?: string;
		other_events: Array<{
			ticketmaster_event_id: string;
			name: string;
			local_date: string;
			venue_name: string | null;
			city: string | null;
		}>;
	} | null;
	rechecked_from: string | null;
	previous: {
		id: string;
		prices_checked_at: string;
		packages: Array<{ label: PlanPackage["label"]; total_minor: number; currency: string }>;
	} | null;
	packages: PlanPackage[];
}

export type LiveStatus =
	"live" | "partial" | "no_offers" | "unavailable" | "not_configured" | "not_needed";

export const api = {
	me: () => request<Me>("/me"),
	onboard: (body: { confirm_18_or_older: true; home_currency: string; home_city?: string }) =>
		request<{ ok: true }>("/me/onboarding", { method: "POST", body: JSON.stringify(body) }),
	logout: () => request<{ ok: true }>("/auth/logout", { method: "POST", body: "{}" }),
	places: (q: string) => request<{ places: Place[] }>(`/places?q=${encodeURIComponent(q)}`),
	parse: (text: string) =>
		request<{ parsed: ParsedTripRequest }>("/trip-requests/parse", {
			method: "POST",
			body: JSON.stringify({ text }),
		}),
	createPlan: (r: TripRequest) =>
		request<{ id: string }>("/plans", { method: "POST", body: JSON.stringify(r) }),
	lookupEvent: (url: string) =>
		request<{ event: EventSummary }>("/events/lookup", {
			method: "POST",
			body: JSON.stringify({ url }),
		}),
	browseEvents: (q: {
		category: EventCategoryId;
		lat: number;
		lng: number;
		radius_km: number;
		date_from: string;
		date_to: string;
	}) =>
		request<{ events: EventSummary[] }>(
			`/events/browse?${new URLSearchParams(
				Object.entries(q).map(([k, v]) => [k, String(v)] as [string, string]),
			)}`,
		),
	plan: (id: string) => request<Plan>(`/plans/${encodeURIComponent(id)}`),
	shared: (token: string) =>
		request<Plan & { shared: true }>(`/shared/${encodeURIComponent(token)}`),
	savedState: (id: string) => request<SavedState>(`/plans/${encodeURIComponent(id)}/saved`),
	save: (id: string) =>
		request<{ saved: true }>(`/plans/${encodeURIComponent(id)}/save`, {
			method: "POST",
			body: "{}",
		}),
	unsave: (id: string) =>
		request<{ saved: false }>(`/plans/${encodeURIComponent(id)}/unsave`, {
			method: "POST",
			body: "{}",
		}),
	setAlerts: (id: string, enabled: boolean) =>
		request<{ alerts_enabled: boolean }>(`/plans/${encodeURIComponent(id)}/alerts`, {
			method: "POST",
			body: JSON.stringify({ enabled }),
		}),
	share: (id: string) =>
		request<{ share_url: string }>(`/plans/${encodeURIComponent(id)}/share`, {
			method: "POST",
			body: "{}",
		}),
	unshare: (id: string) =>
		request<{ share_url: null }>(`/plans/${encodeURIComponent(id)}/share/revoke`, {
			method: "POST",
			body: "{}",
		}),
	trips: () => request<TripsResponse>("/trips"),
	recheck: (id: string) =>
		request<{ id: string }>(`/plans/${encodeURIComponent(id)}/recheck`, {
			method: "POST",
			body: "{}",
		}),
	plans: () =>
		request<{
			plans: Array<{
				id: string;
				status: string;
				created_at: string;
				event_query: string;
				origin_city: string;
				event_name: string | null;
				local_date: string | null;
			}>;
		}>("/plans"),
	...tagalongApi(),
	/** Phase 6: push preferences, one toggle per kind. */
	notificationPrefs: () => request<NotificationPrefs>("/me/notifications"),
	setNotificationPrefs: (update: NotificationPrefsUpdate) =>
		request<NotificationPrefs>("/me/notifications", {
			method: "POST",
			body: JSON.stringify(update),
		}),
	/** Native only: a one-time ticket for the chat socket (the app has no cookie). */
	chatTicket: (kind: RoomKind, id: string) =>
		request<{ ticket: string; expires_at: string }>("/chat/ticket", {
			method: "POST",
			body: JSON.stringify({ kind, id }),
		}),
	signInUrl: () =>
		`${API_BASE}/auth/google/start?return_to=${encodeURIComponent(window.location.href)}`,
};

/** An event from a pasted link or a browse, ready to pin into the form. */
export interface EventSummary {
	pinned: PinnedEvent;
	provider: EventProvider;
	name: string;
	category: string | null;
	venue_name: string | null;
	city: string | null;
	country_code: string | null;
	local_date: string;
	starts_at: string | null;
	url: string | null;
	price_range: { min_minor: number; max_minor: number; currency: string } | null;
}

export interface SavedState {
	saved: boolean;
	alerts_enabled: boolean;
	share_url: string | null;
}

export interface SavedTrip {
	plan_id: string;
	alerts_enabled: boolean;
	best_total_minor: number | null;
	currency: string;
	last_checked_at: string | null;
	saved_at: string;
	event_query: string;
	origin_city: string;
	party_size: number;
	/** Set when the API returns it; keys the Tagalong "Who else is going?" group. */
	event_id?: string | null;
	/** The event's Tagalong group, sent with the row so the list needs no per-trip fetch. */
	group?: GroupSummary | null;
	event_name: string | null;
	local_date: string | null;
	venue_name: string | null;
	event_city: string | null;
	status: string;
}

export interface TripsResponse {
	trips: SavedTrip[];
	alerts: Array<{
		trip_request_id: string;
		plan_id: string;
		old_total_minor: number;
		new_total_minor: number;
		currency: string;
		created_at: string;
		emailed_at: string | null;
	}>;
}

const post = <T>(path: string, body: unknown = {}) =>
	request<T>(path, { method: "POST", body: JSON.stringify(body) });
const enc = encodeURIComponent;

/** Where a chat's message list lives: a group's room or a DM connection's. */
export function roomPath(kind: RoomKind, id: string): string {
	return kind === "group" ? `/groups/${enc(id)}` : `/dms/${enc(id)}`;
}

/** GET …/messages. Cursors are a message's `seq` (`messageCursor` in shared). */
export interface MessagePage {
	/** Oldest first. */
	messages: ChatMessage[];
	/** More exist beyond this page in the direction asked. */
	has_more?: boolean;
	before?: string | null;
	after?: string | null;
}

/** Tagalong (phase 5). Every write is a JSON POST (CSRF rule). */
function tagalongApi() {
	return {
		tagalongOptIn: (body: { confirm: true; name: string; city: string }) =>
			post<{ tagalong: TagalongStatus }>("/tagalong/opt-in", body),
		tagalongOptOut: () => post<{ tagalong: TagalongStatus }>("/tagalong/opt-out"),
		safetyAck: () => post<{ tagalong: TagalongStatus }>("/tagalong/safety-ack"),
		eventGroup: (eventId: string) => request<GroupSummary>(`/events/${enc(eventId)}/group`),
		joinGroup: (eventId: string, interest: string | null) =>
			post<GroupSummary>(`/events/${enc(eventId)}/group/join`, { interest }),
		group: (id: string) => request<GroupDetail>(`/groups/${enc(id)}`),
		leaveGroup: (id: string) => post<{ left: true }>(`/groups/${enc(id)}/leave`),
		setInterest: (id: string, interest: string | null) =>
			post<{ interest: string | null }>(`/groups/${enc(id)}/interest`, { interest }),
		messages: (kind: RoomKind, id: string, q: { after?: string; before?: string } = {}) => {
			const qs = new URLSearchParams(
				Object.entries(q).filter((e): e is [string, string] => typeof e[1] === "string"),
			).toString();
			return request<MessagePage>(`${roomPath(kind, id)}/messages${qs ? `?${qs}` : ""}`);
		},
		sendMessage: (kind: RoomKind, id: string, body: string) =>
			post<{ message: ChatMessage }>(`${roomPath(kind, id)}/messages`, { body }),
		deleteMessage: (id: string) => post<{ deleted: true }>(`/messages/${enc(id)}/delete`),
		profile: (userId: string) => request<TagalongProfile>(`/tagalong/users/${enc(userId)}`),
		connections: () => request<{ connections: Connection[] }>("/connections"),
		connect: (userId: string) =>
			post<{ connection: Connection }>("/connections", { user_id: userId }),
		acceptConnection: (id: string) =>
			post<{ connection: Connection }>(`/connections/${enc(id)}/accept`),
		declineConnection: (id: string) =>
			post<{ connection: Connection }>(`/connections/${enc(id)}/decline`),
		closeConnection: (id: string) =>
			post<{ connection: Connection }>(`/connections/${enc(id)}/close`),
		blocks: () => request<{ blocks: BlockedUser[] }>("/blocks"),
		block: (userId: string) => post<{ blocked: true }>("/blocks", { user_id: userId }),
		unblock: (userId: string) => post<{ blocked: false }>(`/blocks/${enc(userId)}/remove`),
		report: (body: {
			target_type: ReportableTargetType;
			target_id: string;
			reason: ReportReason;
			details?: string;
		}) => post<{ reported: true }>("/reports", body),
		modReports: () => request<{ reports: ModReport[] }>("/mod/reports?status=open"),
		modResolve: (reportId: string, action: ModAction) =>
			post<{ report: ModReport }>(`/mod/reports/${enc(reportId)}/resolve`, { action }),
		modTrust: (userId: string) => post<{ trusted: true }>(`/mod/users/${enc(userId)}/trust`),
	};
}
