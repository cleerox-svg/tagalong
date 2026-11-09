import { formatMoney, type TripRequest } from "@tagalong/shared";
import { useEffect, useId, useState } from "react";
import {
	api,
	ApiError,
	type LiveStatus,
	type Plan,
	type PlanItem,
	type PlanPackage,
	type SavedState,
} from "./api.js";
import { linkTo, navigate } from "./router.js";
import { WhoElse } from "./WhoElse.js";
import { PushOffer, usePushOffer } from "./PushOffer.js";

const LABELS: Record<PlanPackage["label"], string> = {
	cheapest: "Cheapest",
	best_value: "Best value",
	best_experience: "Best experience",
	weekend: "Make a weekend of it",
	alternative: "Alternative",
};

const money = (amount_minor: number, currency: string) => formatMoney({ amount_minor, currency });

const SOURCES: Record<string, string> = {
	ticketmaster: "Ticketmaster",
	eventbrite: "Eventbrite",
	url: "Event page",
	duffel: "Duffel · live",
	"booking.com": "Booking.com · live",
};

function linkText(i: PlanItem): string {
	if (i.kind === "ticket") return "Tickets";
	if (i.provider === "booking.com") return "Book on Booking.com";
	if (i.provider === "duffel") return "Find these flights";
	return "Search";
}

const LIVE_TEXT: Record<LiveStatus, string> = {
	live: "live prices",
	partial: "live prices for some dates, estimates for the rest",
	no_offers: "estimates (no live offers for these dates)",
	unavailable: "estimates (live prices didn't answer in time; re-check to try again)",
	not_configured: "estimates (live prices aren't switched on yet)",
	not_needed: "",
};

function LiveLine({ live }: { live: NonNullable<Plan["result"]>["live"] }) {
	if (!live) return null;
	const parts = [
		live.flights !== "not_needed" && `Flights: ${LIVE_TEXT[live.flights]}.`,
		live.hotels !== "not_needed" && `Hotels: ${LIVE_TEXT[live.hotels]}.`,
	].filter(Boolean);
	return parts.length ? <p className="muted">{parts.join(" ")}</p> : null;
}
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
					<span className="badge src">{SOURCES[i.provider] ?? i.provider}</span>
				)}
				<span className="muted">
					{i.is_estimate ? "table as of" : "as of"} {when(i.fetched_at)}
				</span>
				{i.booking_url && (
					<a href={i.booking_url} target="_blank" rel="noopener noreferrer">
						{linkText(i)} ↗
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

function Package({
	p,
	was,
}: {
	p: PlanPackage;
	was?: { total_minor: number; currency: string } | undefined;
}) {
	const diff = was && was.currency === p.currency ? p.total_minor - was.total_minor : null;
	return (
		<article className="card package">
			<header>
				<span className="label">{LABELS[p.label]}</span>
				<span className="total">{money(p.total_minor, p.currency)}</span>
			</header>
			{diff !== null && was && (
				<p className={diff < 0 ? "change down" : diff > 0 ? "change up" : "change"}>
					{diff === 0
						? "Same as last check"
						: `${diff < 0 ? "Down" : "Up"} ${money(Math.abs(diff), p.currency)} from ${money(was.total_minor, was.currency)}`}
				</p>
			)}
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
			pinned: { provider: "ticketmaster", id: pinned },
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

function SaveShare({ planId }: { planId: string }) {
	const [state, setState] = useState<SavedState | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const push = usePushOffer();
	const alertHint = useId();

	useEffect(() => {
		api.savedState(planId).then(setState, () => setState(null));
	}, [planId]);

	if (!state) return null;
	const act = async (fn: () => Promise<Partial<SavedState>>) => {
		setBusy(true);
		setError(null);
		try {
			const next = await fn();
			setState((s) => (s ? { ...s, ...next } : s));
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="saveshare">
			<div className="row-inline">
				{state.saved ? (
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							act(async () => ({ ...(await api.unsave(planId)), alerts_enabled: false }))
						}
					>
						★ Saved
					</button>
				) : (
					<button
						type="button"
						className="primary"
						disabled={busy}
						onClick={() =>
							act(async () => {
								const res = await api.save(planId);
								push.offer();
								return { ...res, alerts_enabled: true };
							})
						}
					>
						☆ Save trip
					</button>
				)}
				{state.saved && (
					<label className="check">
						<input
							type="checkbox"
							checked={state.alerts_enabled}
							disabled={busy}
							aria-describedby={alertHint}
							onChange={(e) => {
								const on = e.target.checked;
								act(async () => {
									const res = await api.setAlerts(planId, on);
									if (on) push.offer();
									return res;
								});
							}}
						/>
						Alert me if the price drops
					</label>
				)}
				{state.saved && (
					<p id={alertHint} className="note alert-hint">
						We'll email you, and send a push in the app if notifications are on.
					</p>
				)}
				{!state.share_url && (
					<button type="button" disabled={busy} onClick={() => act(() => api.share(planId))}>
						Share
					</button>
				)}
			</div>
			{state.share_url && (
				<div className="share">
					<input
						readOnly
						value={state.share_url}
						aria-label="Share link"
						onFocus={(e) => e.target.select()}
					/>
					<button
						type="button"
						onClick={async () => {
							await navigator.clipboard?.writeText(state.share_url ?? "").catch(() => undefined);
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						}}
					>
						{copied ? "Copied" : "Copy"}
					</button>
					<button
						type="button"
						className="link"
						disabled={busy}
						onClick={() => act(() => api.unshare(planId))}
					>
						Stop sharing
					</button>
					<p className="note">
						Anyone with this link can see these packages. They can't see your account or change
						anything.
					</p>
				</div>
			)}
			<PushOffer state={push} question="Get a notification on this phone if the price drops?" />
			{error && <p className="error">{error}</p>}
		</div>
	);
}

export function PlanView(props: { id: string } | { token: string }) {
	const id = "id" in props ? props.id : null;
	const token = "token" in props ? props.token : null;
	const shared = token !== null;
	const [plan, setPlan] = useState<Plan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [rechecking, setRechecking] = useState(false);

	useEffect(() => {
		let stop = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = async () => {
			try {
				const p = token ? await api.shared(token) : await api.plan(id as string);
				if (stop) return;
				setPlan(p);
				if (p.status === "queued" || p.status === "running") timer = setTimeout(tick, 1500);
			} catch (err) {
				if (!stop)
					setError(
						err instanceof ApiError && err.status === 404
							? token
								? "This link doesn't work any more."
								: "No such plan."
							: "We can't load this plan right now.",
					);
			}
		};
		void tick();
		return () => {
			stop = true;
			if (timer) clearTimeout(timer);
		};
	}, [id, token]);

	if (error) return <p className="error">{error}</p>;
	if (!plan) return <p className="muted">Loading…</p>;

	const budget = plan.result?.budget_total_minor ?? plan.budget_minor;
	const settled = !shared && (plan.status === "done" || plan.status === "failed");
	const recheck = async () => {
		setRechecking(true);
		try {
			const { id: next } = await api.recheck(plan.id);
			navigate(`/plans/${next}`);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
		} finally {
			setRechecking(false);
		}
	};

	return (
		<>
			{shared && (
				<p className="note banner">
					A trip someone shared with you — read only.{" "}
					<a href="/" onClick={linkTo("/")}>
						Plan your own
					</a>
				</p>
			)}
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
				{plan.status === "done" && <LiveLine live={plan.result?.live} />}
				{settled && (
					<div className="recheck">
						{plan.result?.prices_checked_at && (
							<span className="muted">Prices checked {when(plan.result.prices_checked_at)}</span>
						)}
						{plan.previous && (
							<span className="muted">
								· previous check {when(plan.previous.prices_checked_at)}
							</span>
						)}
						<button type="button" onClick={recheck} disabled={rechecking}>
							{rechecking ? "Starting…" : "Re-check prices"}
						</button>
					</div>
				)}
				{!shared && plan.status === "done" && <SaveShare planId={plan.id} />}
				{shared && plan.result?.prices_checked_at && (
					<p className="muted">Prices checked {when(plan.result.prices_checked_at)}</p>
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
				<Package key={p.id} p={p} was={plan.previous?.packages.find((x) => x.label === p.label)} />
			))}

			{!shared && plan.event_id && <WhoElse eventId={plan.event_id} />}

			{!shared && plan.status === "done" && plan.result && plan.result.other_events.length > 0 && (
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
				<a href="/" onClick={linkTo("/")}>
					← Plan another trip
				</a>
			</p>
		</>
	);
}
