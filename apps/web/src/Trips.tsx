import { formatMoney } from "@tagalong/shared";
import { useEffect, useState } from "react";
import { api, type TripsResponse } from "./api.js";
import { navigate } from "./router.js";

const money = (amount_minor: number, currency: string) => formatMoney({ amount_minor, currency });
const when = (iso: string) =>
	new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function Trips() {
	const [data, setData] = useState<TripsResponse | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = () =>
		api.trips().then(setData, () => setError("We can't load your trips right now."));
	useEffect(() => {
		void load();
	}, []);

	if (error) return <p className="error">{error}</p>;
	if (!data) return <p className="muted">Loading…</p>;

	const open = (planId: string) => (e: React.MouseEvent) => {
		e.preventDefault();
		navigate(`/plans/${planId}`);
	};

	return (
		<>
			<section className="card">
				<h1>My trips</h1>
				{data.trips.length === 0 && (
					<p className="muted">
						Nothing saved yet. Plan a trip and press <strong>Save trip</strong> to keep it here and
						get an email if the price drops.
					</p>
				)}
				<ul className="trips">
					{data.trips.map((t) => (
						<li key={t.plan_id}>
							<div>
								<a href={`/plans/${t.plan_id}`} onClick={open(t.plan_id)}>
									<strong>{t.event_name ?? t.event_query}</strong>
								</a>
								<div className="muted">
									{t.local_date ?? "date to confirm"}
									{t.event_city && ` · ${t.event_city}`} · from {t.origin_city} · {t.party_size}{" "}
									{t.party_size === 1 ? "person" : "people"}
								</div>
								<div className="muted">
									{t.best_total_minor !== null
										? `Best seen: from ${money(t.best_total_minor, t.currency)}`
										: "Nothing has fit the budget yet"}
									{t.last_checked_at && ` · checked ${when(t.last_checked_at)}`}
								</div>
							</div>
							<label className="check">
								<input
									type="checkbox"
									checked={t.alerts_enabled}
									onChange={async (e) => {
										await api.setAlerts(t.plan_id, e.target.checked).catch(() => undefined);
										void load();
									}}
								/>
								Price-drop emails
							</label>
						</li>
					))}
				</ul>
			</section>

			{data.alerts.length > 0 && (
				<section className="card">
					<h2>Price drops</h2>
					<ul className="trips">
						{data.alerts.map((a) => (
							<li key={`${a.plan_id}`}>
								<a href={`/plans/${a.plan_id}`} onClick={open(a.plan_id)}>
									Down to {money(a.new_total_minor, a.currency)} from{" "}
									{money(a.old_total_minor, a.currency)}
								</a>
								<span className="muted">
									{when(a.created_at)}
									{a.emailed_at ? " · emailed" : ""}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</>
	);
}
