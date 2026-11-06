import { formatMoney, type TripRequest } from "@tagalong/shared";
import { useEffect, useState } from "react";
import { api, ApiError, type Plan, type PlanItem, type PlanPackage } from "./api.js";
import { navigate } from "./router.js";

const LABELS: Record<PlanPackage["label"], string> = {
	cheapest: "Cheapest",
	best_value: "Best value",
	best_experience: "Best experience",
	weekend: "Make a weekend of it",
	alternative: "Alternative",
};

const money = (amount_minor: number, currency: string) => formatMoney({ amount_minor, currency });
const when = (iso: string) =>
	new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Item({ i, home }: { i: PlanItem; home: string }) {
	return (
		<li className="item">
			<div className="item-head">
				<span>{i.title}</span>
				<span className="amount">
					{money(i.amount_minor, i.currency)}
					{i.currency !== home && ` ${i.currency}`}
				</span>
			</div>
			<div className="item-meta">
				{i.is_estimate ? (
					<span className="badge est">estimate</span>
				) : (
					<span className="badge src">{i.provider}</span>
				)}
				<span className="muted">
					{i.is_estimate ? "table as of" : "as of"} {when(i.fetched_at)}
				</span>
				{i.booking_url && (
					<a href={i.booking_url} target="_blank" rel="noopener noreferrer">
						{i.kind === "ticket" ? "Tickets" : "Search"} ↗
					</a>
				)}
			</div>
			<details>
				<summary>How we got this</summary>
				<p>{i.method}</p>
			</details>
		</li>
	);
}

function Package({ p }: { p: PlanPackage }) {
	return (
		<article className="card package">
			<header>
				<span className="label">{LABELS[p.label]}</span>
				<span className="total">{money(p.total_minor, p.currency)}</span>
			</header>
			<p>{p.summary_text}</p>
			{p.details.passport_needed && <p className="note">Crossing a border: bring your passport.</p>}
			{p.details.is_alternative_event && <p className="note">A different date for this event.</p>}
			<ul className="items">
				{p.items.map((i, n) => (
					<Item key={n} i={i} home={p.currency} />
				))}
			</ul>
		</article>
	);
}

function requestFrom(plan: Plan, pinned: string): TripRequest {
	return {
		origin: {
			label: plan.origin_city,
			lat: plan.origin_lat,
			lng: plan.origin_lng,
			country_code: plan.origin_country,
		},
		event: {
			query: plan.event_query,
			...(plan.requested_event_city ? { city: plan.requested_event_city } : {}),
			ticketmaster_event_id: pinned,
		},
		date_from: plan.date_from,
		date_to: plan.date_to,
		party_size: plan.party_size,
		budget: {
			amount_minor: plan.budget_minor,
			currency: plan.budget_currency,
			scope: plan.budget_scope,
		},
		prefs: plan.prefs,
	};
}

export function PlanView({ id }: { id: string }) {
	const [plan, setPlan] = useState<Plan | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let stop = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = async () => {
			try {
				const p = await api.plan(id);
				if (stop) return;
				setPlan(p);
				if (p.status === "queued" || p.status === "running") timer = setTimeout(tick, 1500);
			} catch (err) {
				if (!stop)
					setError(
						err instanceof ApiError && err.status === 404
							? "No such plan."
							: "We can't load this plan right now.",
					);
			}
		};
		void tick();
		return () => {
			stop = true;
			if (timer) clearTimeout(timer);
		};
	}, [id]);

	if (error) return <p className="error">{error}</p>;
	if (!plan) return <p className="muted">Loading…</p>;

	const budget = plan.result?.budget_total_minor ?? plan.budget_minor;

	return (
		<>
			<section className="card">
				<h1>{plan.event_name ?? plan.event_query}</h1>
				<p className="muted">
					From {plan.origin_city} · {plan.party_size} {plan.party_size === 1 ? "person" : "people"}{" "}
					· budget {money(budget, plan.budget_currency)} total
					{plan.local_date && ` · ${plan.local_date}`}
					{plan.venue_name && ` · ${plan.venue_name}, ${plan.event_city ?? ""}`}
				</p>
				{(plan.status === "queued" || plan.status === "running") && (
					<p className="progress" aria-live="polite">
						{plan.progress ?? "Working…"}
					</p>
				)}
				{plan.status === "failed" && <p className="error">{plan.error}</p>}
				{plan.status === "done" && plan.result && (
					<p className="muted">
						{plan.result.within_budget} of {plan.result.considered} combinations fit your budget.
						{plan.result.fx.map(
							(r) => ` 1 ${r.from} = ${r.rate.toFixed(4)} ${r.to} (ECB, ${r.as_of}).`,
						)}
					</p>
				)}
			</section>

			{plan.status === "done" && plan.packages.length === 0 && plan.result && (
				<section className="card">
					<h2>Nothing fits this budget yet</h2>
					<p>
						We don't show trips over budget.
						{plan.result.cheapest_over_budget_minor !== null &&
							` The cheapest combination we found comes to about ${money(plan.result.cheapest_over_budget_minor, plan.budget_currency)}.`}{" "}
						Try a bigger budget, fewer nights, or another date.
					</p>
				</section>
			)}

			{plan.status === "done" && plan.packages.length > 0 && plan.packages.length < 5 && (
				<p className="note">
					Only {plan.packages.length} genuinely different package
					{plan.packages.length > 1 ? "s" : ""} fit your budget, so we're not padding the list with
					near-copies.
				</p>
			)}

			{plan.packages.map((p) => (
				<Package key={p.id} p={p} />
			))}

			{plan.status === "done" && plan.result && plan.result.other_events.length > 0 && (
				<section className="card">
					<h2>Not the right event?</h2>
					<ul className="others">
						{plan.result.other_events.map((e) => (
							<li key={e.ticketmaster_event_id}>
								<span>
									{e.name} — {e.local_date}
									{e.venue_name && `, ${e.venue_name}`}
								</span>
								<button
									type="button"
									onClick={async () => {
										const { id: next } = await api.createPlan(
											requestFrom(plan, e.ticketmaster_event_id),
										);
										navigate(`/plans/${next}`);
									}}
								>
									Plan this one
								</button>
							</li>
						))}
					</ul>
				</section>
			)}

			<p>
				<a
					href="/"
					onClick={(e) => {
						e.preventDefault();
						navigate("/");
					}}
				>
					← Plan another trip
				</a>
			</p>
		</>
	);
}
