/**
 * The plan as the app shows it. Every query is scoped by the owner's user_id;
 * a share link resolves to (plan, owner) first and then reads through here, so
 * a token can never reach another user's data.
 */
export type PlanView = Record<string, unknown> & {
	prefs: Record<string, unknown>;
	result: Record<string, unknown> | null;
	previous: unknown;
	packages: unknown[];
};

export async function loadPlan(
	db: D1Database,
	id: string,
	userId: string,
): Promise<PlanView | null> {
	// Scoped by user_id in the query itself: someone else's plan is a 404, not a 403.
	const plan = await db
		.prepare(
			`SELECT p.id, p.status, p.progress, p.error, p.result_json, p.created_at, p.updated_at, p.rechecked_from,
		   t.origin_city, t.origin_lat, t.origin_lng, t.origin_country, t.event_query, t.event_city AS requested_event_city, t.date_from, t.date_to, t.party_size,
		   t.budget_minor, t.budget_currency, t.budget_scope, t.prefs_json,
		   e.id AS event_id, e.name AS event_name, e.venue_name, e.city AS event_city, e.country AS event_country,
		   e.local_date, e.starts_at, e.url AS event_url, e.fetched_at AS event_fetched_at
		 FROM plans p JOIN trip_requests t ON t.id = p.trip_request_id LEFT JOIN events e ON e.id = p.event_id
		 WHERE p.id = ? AND p.user_id = ?`,
		)
		.bind(id, userId)
		.first<Record<string, unknown>>();
	if (!plan) return null;

	let packages: unknown[] = [];
	if (plan.status === "done") {
		const { results: pkgs } = await db
			.prepare(
				`SELECT k.id, k.rank, k.label, k.total_minor, k.currency, k.score, k.summary_text, k.details_json,
			   e.name AS event_name, e.local_date, e.venue_name, e.city AS event_city, e.url AS event_url
			 FROM packages k JOIN plans p ON p.id = k.plan_id JOIN events e ON e.id = k.event_id
			 WHERE k.plan_id = ? AND p.user_id = ? ORDER BY k.rank`,
			)
			.bind(id, userId)
			.all<Record<string, unknown>>();
		const { results: items } = await db
			.prepare(
				`SELECT i.package_id, i.kind, i.title, i.provider, i.amount_minor, i.currency, i.is_estimate,
			   i.booking_url, i.fetched_at, i.method
			 FROM package_items i JOIN packages k ON k.id = i.package_id JOIN plans p ON p.id = k.plan_id
			 WHERE k.plan_id = ? AND p.user_id = ? ORDER BY k.rank, i.position`,
			)
			.bind(id, userId)
			.all<Record<string, unknown>>();
		packages = pkgs.map(({ details_json, ...k }) => ({
			...k,
			details: JSON.parse(String(details_json)),
			items: items
				.filter((i) => i.package_id === k.id)
				.map(({ package_id: _p, is_estimate, ...i }) => ({ ...i, is_estimate: is_estimate === 1 })),
		}));
	}

	// What the plan this one re-checks cost, per label, for "was X, now Y".
	let previous: unknown = null;
	if (plan.rechecked_from) {
		const prev = await db
			.prepare("SELECT id, created_at, result_json FROM plans WHERE id = ? AND user_id = ?")
			.bind(plan.rechecked_from, userId)
			.first<{ id: string; created_at: string; result_json: string | null }>();
		if (prev) {
			const { results: prevPkgs } = await db
				.prepare(
					`SELECT k.label, k.total_minor, k.currency FROM packages k JOIN plans p ON p.id = k.plan_id
				 WHERE k.plan_id = ? AND p.user_id = ? ORDER BY k.rank`,
				)
				.bind(prev.id, userId)
				.all<{ label: string; total_minor: number; currency: string }>();
			const prevResult = prev.result_json
				? (JSON.parse(prev.result_json) as { prices_checked_at?: string })
				: null;
			previous = {
				id: prev.id,
				prices_checked_at: prevResult?.prices_checked_at ?? prev.created_at,
				packages: prevPkgs,
			};
		}
	}

	const { result_json, prefs_json, ...rest } = plan;
	return {
		...rest,
		prefs: JSON.parse(String(prefs_json)) as Record<string, unknown>,
		result: result_json ? (JSON.parse(String(result_json)) as Record<string, unknown>) : null,
		previous,
		packages,
	};
}

/** Lowest package total of a finished plan, or null when nothing fit the budget. */
export async function cheapestTotal(db: D1Database, planId: string): Promise<number | null> {
	const row = await db
		.prepare("SELECT MIN(total_minor) AS best FROM packages WHERE plan_id = ?")
		.bind(planId)
		.first<{ best: number | null }>();
	return row?.best ?? null;
}
