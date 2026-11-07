/**
 * Category browse (spec §9 phase 4): "gaming events near Toronto in May".
 * Picking a result pins it into the trip form below.
 */
import {
	BROWSE_RADIUS_KM,
	EVENT_CATEGORIES,
	type EventCategoryId,
	formatMoney,
	type Place,
} from "@tagalong/shared";
import { useEffect, useState } from "react";
import { api, ApiError, type EventSummary } from "./api.js";

export interface BrowseStart {
	category: EventCategoryId;
	near_text: string;
	near: Place | null;
	date_from: string;
	date_to: string;
}

export function priceText(e: Pick<EventSummary, "price_range">): string | null {
	const p = e.price_range;
	if (!p) return null;
	if (p.max_minor === 0) return "Free";
	const lo = formatMoney({ amount_minor: p.min_minor, currency: p.currency });
	if (p.max_minor === p.min_minor) return `${lo} each`;
	return `${lo}–${formatMoney({ amount_minor: p.max_minor, currency: p.currency })} each`;
}

export function Browse({
	start,
	onPick,
}: {
	start: BrowseStart;
	onPick: (e: EventSummary) => void;
}) {
	const [q, setQ] = useState(start);
	const [radius, setRadius] = useState<number>(100);
	const [places, setPlaces] = useState<Place[] | null>(null);
	const [results, setResults] = useState<EventSummary[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function findNear(text: string) {
		setPlaces(null);
		setError(null);
		if (text.trim().length < 2) return;
		try {
			const { places: found } = await api.places(text);
			if (found.length === 1 && found[0]) setQ((s) => ({ ...s, near: found[0] ?? null }));
			else if (found.length === 0) setError("We couldn't find that city. Try adding the country.");
			else setPlaces(found);
		} catch {
			setError("City search isn't working right now.");
		}
	}

	// A city named by the parse step still has to be looked up and confirmed.
	useEffect(() => {
		if (start.near_text && !start.near) void findNear(start.near_text);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function search(e: React.FormEvent) {
		e.preventDefault();
		if (!q.near) return setError("Pick a city to search near.");
		if (!q.date_from || !q.date_to || q.date_from > q.date_to)
			return setError("Pick a start and end date.");
		setBusy(true);
		setError(null);
		try {
			const { events } = await api.browseEvents({
				category: q.category,
				lat: q.near.lat,
				lng: q.near.lng,
				radius_km: radius,
				date_from: q.date_from,
				date_to: q.date_to,
			});
			setResults(events);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : "Event search isn't working right now.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="card" onSubmit={search} noValidate>
			<h2>Browse events</h2>
			<p className="muted">Not sure what's on? Pick a kind of event, a city and some dates.</p>
			<div className="row">
				<label>
					Kind of event
					<select
						value={q.category}
						onChange={(e) => setQ({ ...q, category: e.target.value as EventCategoryId })}
					>
						{EVENT_CATEGORIES.map((c) => (
							<option key={c.id} value={c.id}>
								{c.label}
							</option>
						))}
					</select>
				</label>
				<label>
					Within
					<select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
						{BROWSE_RADIUS_KM.map((r) => (
							<option key={r} value={r}>
								{r} km
							</option>
						))}
					</select>
				</label>
			</div>
			<label>
				Near
				<div className="row">
					<input
						aria-label="City to search near"
						placeholder="City"
						value={q.near_text}
						onChange={(e) => setQ({ ...q, near_text: e.target.value, near: null })}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void findNear(q.near_text);
							}
						}}
					/>
					<button type="button" onClick={() => findNear(q.near_text)}>
						Find
					</button>
				</div>
			</label>
			{q.near && <p className="confirmed">✓ {q.near.label}</p>}
			{places && !q.near && (
				<div className="choices" role="group" aria-label="Which city?">
					<p>Which one?</p>
					{places.map((p) => (
						<button
							type="button"
							key={`${p.lat},${p.lng}`}
							onClick={() => {
								setQ((s) => ({ ...s, near: p }));
								setPlaces(null);
							}}
						>
							{p.label}
						</button>
					))}
				</div>
			)}
			<div className="row">
				<label>
					From
					<input
						type="date"
						value={q.date_from}
						onChange={(e) => setQ({ ...q, date_from: e.target.value })}
					/>
				</label>
				<label>
					To
					<input
						type="date"
						value={q.date_to}
						onChange={(e) => setQ({ ...q, date_to: e.target.value })}
					/>
				</label>
			</div>
			{error && <p className="error">{error}</p>}
			<button disabled={busy}>{busy ? "Searching…" : "Find events"}</button>

			{results && results.length === 0 && (
				<p className="note">
					Nothing listed on Ticketmaster for that. Try a wider radius or other dates — or paste the
					event's link in the form below.
				</p>
			)}
			{results && results.length > 0 && (
				<ul className="others">
					{results.map((e) => (
						<li key={e.pinned.provider === "url" ? e.pinned.url : e.pinned.id}>
							<span>
								<strong>{e.name}</strong> — {e.local_date}
								{e.venue_name && `, ${e.venue_name}`}
								{e.city && `, ${e.city}`}
								{priceText(e) && <span className="muted"> · {priceText(e)}</span>}
							</span>
							<button type="button" onClick={() => onPick(e)}>
								Plan a trip to this
							</button>
						</li>
					))}
				</ul>
			)}
		</form>
	);
}
