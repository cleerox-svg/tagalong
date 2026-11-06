import type { ParsedTripRequest, Place, TripRequest } from "@tagalong/shared";

export const API_BASE = __API_BASE__;

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.body) headers.set("Content-Type", "application/json");
	const res = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
	const body = (await res.json().catch(() => null)) as {
		error?: { code: string; message: string };
	} | null;
	if (!res.ok)
		throw new ApiError(
			res.status,
			body?.error?.code ?? "error",
			body?.error?.message ?? `HTTP ${res.status}`,
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
	plan: (id: string) => request<Plan>(`/plans/${encodeURIComponent(id)}`),
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
	signInUrl: () =>
		`${API_BASE}/auth/google/start?return_to=${encodeURIComponent(window.location.href)}`,
};
