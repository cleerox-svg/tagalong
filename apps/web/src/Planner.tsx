import { SEAT_TIERS, STAY_TYPES, TRANSPORT_MODES, VIBE_TAGS, type Place } from "@tagalong/shared";
import { useEffect, useState } from "react";
import { api, ApiError, type EventSummary, type Me } from "./api.js";
import { Browse, type BrowseStart, priceText } from "./Browse.js";
import {
	applyParsed,
	describeEvent,
	emptyForm,
	type FormState,
	pinEvent,
	toTripRequest,
	unpinEvent,
} from "./form.js";
import { COMMON_CURRENCIES } from "./Onboarding.js";
import { navigate } from "./router.js";

const label = (s: string) => s.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const SOURCE: Record<EventSummary["provider"], string> = {
	ticketmaster: "Ticketmaster",
	eventbrite: "Eventbrite",
	url: "the event's page",
	manual: "you",
};

export function Planner({ me }: { me: Me }) {
	const [form, setForm] = useState<FormState>(() => emptyForm(me.home_currency ?? "CAD"));
	const [text, setText] = useState("");
	const [parsing, setParsing] = useState(false);
	const [parseNote, setParseNote] = useState<string | null>(null);
	const [places, setPlaces] = useState<Place[] | null>(null);
	const [placeError, setPlaceError] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [submitting, setSubmitting] = useState(false);
	const [link, setLink] = useState("");
	const [reading, setReading] = useState(false);
	const [linkError, setLinkError] = useState<{
		code: string;
		message: string;
		title: string | null;
	} | null>(null);
	const [picked, setPicked] = useState<EventSummary | null>(null);
	const [browse, setBrowse] = useState<{ start: BrowseStart; key: number } | null>(null);
	const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
		setForm((f) => ({ ...f, [k]: v }));

	async function findOrigin(q: string) {
		setPlaceError(null);
		setPlaces(null);
		if (q.trim().length < 2) return;
		try {
			const { places: found } = await api.places(q);
			if (found.length === 1 && found[0]) set("origin", found[0]);
			else if (found.length === 0)
				setPlaceError("We couldn't find that city. Try adding the country.");
			else setPlaces(found);
		} catch {
			setPlaceError("City search isn't working right now.");
		}
	}

	// A city named by the parse step still has to be looked up and confirmed.
	useEffect(() => {
		if (form.origin_text && !form.origin) void findOrigin(form.origin_text);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [form.origin_text]);

	function pick(e: EventSummary) {
		setPicked(e);
		setLinkError(null);
		setForm((f) => pinEvent(f, e));
		document.getElementById("trip-details")?.scrollIntoView({ behavior: "smooth" });
	}

	async function readLink(url: string) {
		setLinkError(null);
		if (url.trim().length < 8) return;
		setReading(true);
		try {
			const { event } = await api.lookupEvent(url.trim());
			pick(event);
			setLink("");
		} catch (err) {
			const title =
				err instanceof ApiError &&
				typeof err.details === "object" &&
				err.details !== null &&
				"title" in err.details &&
				typeof err.details.title === "string"
					? err.details.title
					: null;
			setLinkError({
				code: err instanceof ApiError ? err.code : "error",
				message: err instanceof ApiError ? err.message : "We couldn't read that link right now.",
				title,
			});
		} finally {
			setReading(false);
		}
	}

	function openBrowse(start: Partial<BrowseStart> = {}) {
		setBrowse((b) => ({
			key: (b?.key ?? 0) + 1,
			start: {
				category: "sports",
				near_text: form.origin?.label ?? form.origin_text,
				near: form.origin,
				date_from: form.date_from,
				date_to: form.date_to,
				...start,
			},
		}));
	}

	async function parse() {
		setParsing(true);
		setParseNote(null);
		try {
			const { parsed } = await api.parse(text);
			setForm((f) => applyParsed(f, parsed, text));
			if (parsed.event_query) setPicked(null);
			if (parsed.event_url) {
				setLink(parsed.event_url);
				void readLink(parsed.event_url);
			} else if (parsed.event_category && !parsed.event_query) {
				const near = parsed.event_city ?? parsed.origin_text ?? "";
				openBrowse({
					category: parsed.event_category,
					near_text: near,
					near: null,
					date_from: parsed.date_from ?? form.date_from,
					date_to: parsed.date_to ?? parsed.date_from ?? form.date_to,
				});
				setParseNote("Pick an event from the list, then check the trip details below.");
				return;
			}
			setParseNote("Check the details below, change anything that's wrong, then find packages.");
		} catch (err) {
			setParseNote(
				err instanceof ApiError ? err.message : "We couldn't read that. Fill in the form instead.",
			);
		} finally {
			setParsing(false);
		}
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const r = toTripRequest(form);
		if (!r.ok) return setErrors(r.errors);
		setErrors({});
		setSubmitting(true);
		try {
			const { id } = await api.createPlan(r.request);
			navigate(`/plans/${id}`);
		} catch (err) {
			setErrors({
				form: err instanceof ApiError ? err.message : "That didn't go through. Try again.",
			});
			setSubmitting(false);
		}
	}

	const err = (k: string) => (errors[k] ? <span className="field-error">{errors[k]}</span> : null);

	return (
		<>
			<section className="card">
				<h1>Plan a trip</h1>
				<label>
					Describe it in your own words
					<textarea
						rows={3}
						maxLength={2000}
						placeholder="I'm in Toronto, I want to see the Knicks at MSG in March, $1,200 CAD for two of us, we'd rather drive, we like food and nightlife."
						value={text}
						onChange={(e) => setText(e.target.value)}
					/>
				</label>
				<button type="button" onClick={parse} disabled={parsing || text.trim().length < 3}>
					{parsing ? "Reading…" : "Fill in the form for me"}
				</button>
				{parseNote && <p className="note">{parseNote}</p>}
			</section>

			{browse && <Browse key={browse.key} start={browse.start} onPick={pick} />}

			<form className="card" id="trip-details" onSubmit={submit} noValidate>
				<h2>Trip details</h2>

				<fieldset>
					<legend>Where you're starting from</legend>
					<div className="row">
						<input
							aria-label="Starting city"
							placeholder="City"
							value={form.origin_text}
							onChange={(e) =>
								setForm((f) => ({ ...f, origin_text: e.target.value, origin: null }))
							}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									void findOrigin(form.origin_text);
								}
							}}
						/>
						<button type="button" onClick={() => findOrigin(form.origin_text)}>
							Find
						</button>
					</div>
					{form.origin && <p className="confirmed">✓ {form.origin.label}</p>}
					{places && !form.origin && (
						<div className="choices" role="group" aria-label="Which city?">
							<p>Which one?</p>
							{places.map((p) => (
								<button
									type="button"
									key={`${p.lat},${p.lng}`}
									onClick={() => {
										set("origin", p);
										setPlaces(null);
									}}
								>
									{p.label}
								</button>
							))}
						</div>
					)}
					{placeError && <p className="error">{placeError}</p>}
					{err("origin")}
				</fieldset>

				<fieldset>
					<legend>The event</legend>
					{form.pinned && !form.manual ? (
						<div className="picked">
							<p className="confirmed">
								✓ {picked?.name ?? form.event_query} — {form.date_from}
								{picked?.venue_name && `, ${picked.venue_name}`}
								{(picked?.city ?? form.event_city) && `, ${picked?.city ?? form.event_city}`}
							</p>
							<p className="muted">
								From {SOURCE[picked?.provider ?? form.pinned.provider]}
								{picked && priceText(picked) && ` · tickets ${priceText(picked)}`}
								{picked?.url && (
									<>
										{" · "}
										<a href={picked.url} target="_blank" rel="noopener noreferrer">
											event page ↗
										</a>
									</>
								)}
							</p>
							<button
								type="button"
								onClick={() => {
									setPicked(null);
									setForm(unpinEvent);
								}}
							>
								Pick a different event
							</button>
						</div>
					) : form.manual ? (
						<>
							<p className="note">
								We'll plan around the city and date you give. Ticket prices will be an estimate, so
								check the real price before you book.
							</p>
							<label>
								Event name
								<input
									value={form.event_query}
									maxLength={200}
									onChange={(e) => set("event_query", e.target.value)}
								/>
								{err("event_query")}
							</label>
							<div className="row">
								<label>
									City
									<input
										value={form.event_city}
										maxLength={100}
										onChange={(e) => set("event_city", e.target.value)}
										placeholder="Ottawa"
									/>
									{err("event_city")}
								</label>
								<label>
									Date
									<input
										type="date"
										value={form.date_from}
										onChange={(e) => setForm((f) => ({ ...f, date_from: e.target.value }))}
									/>
									{err("date_from")}
								</label>
							</div>
							<button type="button" className="link" onClick={() => setForm(unpinEvent)}>
								Search for it instead
							</button>
						</>
					) : (
						<>
							<label>
								Team, artist or event
								<input
									value={form.event_query}
									onChange={(e) => set("event_query", e.target.value)}
									placeholder="Knicks"
								/>
								{err("event_query")}
							</label>
							<label>
								Event city (optional)
								<input
									value={form.event_city}
									onChange={(e) => set("event_city", e.target.value)}
									placeholder="New York"
								/>
							</label>
							<div className="row">
								<label>
									From
									<input
										type="date"
										value={form.date_from}
										onChange={(e) => set("date_from", e.target.value)}
									/>
									{err("date_from")}
								</label>
								<label>
									To
									<input
										type="date"
										value={form.date_to}
										onChange={(e) => set("date_to", e.target.value)}
									/>
									{err("date_to")}
								</label>
							</div>
							<label>
								Or paste the event's link (Eventbrite, Ticketmaster, a venue or festival page)
								<div className="row">
									<input
										type="url"
										inputMode="url"
										placeholder="https://www.eventbrite.com/e/…"
										value={link}
										maxLength={2000}
										onChange={(e) => setLink(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												void readLink(link);
											}
										}}
									/>
									<button
										type="button"
										onClick={() => readLink(link)}
										disabled={reading || link.trim().length < 8}
									>
										{reading ? "Reading…" : "Read link"}
									</button>
								</div>
							</label>
							{linkError && (
								<div className="error">
									<p>{linkError.message}</p>
									{linkError.code === "unreadable" && (
										<button
											type="button"
											onClick={() => {
												setForm((f) => describeEvent(f, linkError.title));
												setLinkError(null);
											}}
										>
											Tell us the date and city
										</button>
									)}
								</div>
							)}
							<p className="muted">
								Not sure which event?{" "}
								<button type="button" className="link" onClick={() => openBrowse()}>
									Browse by kind of event
								</button>{" "}
								or{" "}
								<button
									type="button"
									className="link"
									onClick={() => setForm((f) => describeEvent(f, null))}
								>
									describe it yourself
								</button>
								.
							</p>
						</>
					)}
				</fieldset>

				<fieldset>
					<legend>Who and how much</legend>
					<div className="row">
						<label>
							People
							<input
								type="number"
								min={1}
								max={20}
								value={form.party_size}
								onChange={(e) => set("party_size", e.target.value)}
							/>
							{err("party_size")}
						</label>
						<label>
							Budget
							<input
								inputMode="decimal"
								value={form.budget_amount}
								onChange={(e) => set("budget_amount", e.target.value)}
								placeholder="1200"
							/>
							{err("budget_amount")}
						</label>
						<label>
							Currency
							<input
								list="currencies"
								value={form.budget_currency}
								maxLength={3}
								onChange={(e) => set("budget_currency", e.target.value.toUpperCase())}
							/>
							<datalist id="currencies">
								{COMMON_CURRENCIES.map((c) => (
									<option key={c} value={c} />
								))}
							</datalist>
							{err("budget_currency")}
						</label>
						<label>
							For
							<select
								value={form.budget_scope}
								onChange={(e) => set("budget_scope", e.target.value as FormState["budget_scope"])}
							>
								<option value="total">Everyone, total</option>
								<option value="per_person">Each person</option>
							</select>
						</label>
					</div>
				</fieldset>

				<fieldset>
					<legend>What you like</legend>
					<div className="row">
						<label>
							Getting there
							<select
								value={form.transport}
								onChange={(e) => set("transport", e.target.value as FormState["transport"])}
							>
								<option value="any">Any</option>
								{TRANSPORT_MODES.map((m) => (
									<option key={m} value={m}>
										{label(m)}
									</option>
								))}
							</select>
						</label>
						<label>
							Staying
							<select
								value={form.stay}
								onChange={(e) => set("stay", e.target.value as FormState["stay"])}
							>
								<option value="any">Any</option>
								{STAY_TYPES.map((m) => (
									<option key={m} value={m}>
										{label(m)}
									</option>
								))}
							</select>
						</label>
						<label>
							Max nights
							<input
								type="number"
								min={0}
								max={7}
								value={form.max_nights}
								onChange={(e) => set("max_nights", e.target.value)}
							/>
							{err("max_nights")}
						</label>
						<label>
							Seats
							<select
								value={form.seat_quality}
								onChange={(e) => set("seat_quality", e.target.value as FormState["seat_quality"])}
							>
								<option value="any">Any</option>
								{SEAT_TIERS.map((m) => (
									<option key={m} value={m}>
										{label(m)}
									</option>
								))}
							</select>
						</label>
					</div>
					<div className="tags" role="group" aria-label="Vibe">
						{VIBE_TAGS.map((t) => (
							<label key={t} className="tag">
								<input
									type="checkbox"
									checked={form.vibe_tags.includes(t)}
									onChange={(e) =>
										set(
											"vibe_tags",
											e.target.checked
												? [...form.vibe_tags, t]
												: form.vibe_tags.filter((x) => x !== t),
										)
									}
								/>
								{label(t)}
							</label>
						))}
					</div>
					<label>
						Accessibility needs (optional)
						<input
							value={form.accessibility}
							maxLength={500}
							onChange={(e) => set("accessibility", e.target.value)}
						/>
					</label>
				</fieldset>

				{err("form")}
				<button className="primary" disabled={submitting}>
					{submitting ? "Starting…" : "Find packages"}
				</button>
			</form>
		</>
	);
}
