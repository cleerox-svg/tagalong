import { INTEREST_MAX, type GroupSummary } from "@tagalong/shared";
import { useEffect, useId, useState } from "react";
import { api, ApiError } from "./api.js";
import { linkTo, navigate } from "./router.js";
import { TagalongGate, useMe } from "./TagalongGate.js";

/**
 * "Who else is going?" for an event the user has a plan for. Only rendered in
 * the owner's views (plan, saved trips) — never on a public share link.
 *
 * Pass `summary` when the caller already has it (My trips gets it with each
 * row) so a list doesn't make one request per trip; without it, it's fetched.
 */
export function WhoElse({
	eventId,
	summary: given,
	compact = false,
}: {
	eventId: string;
	summary?: GroupSummary;
	compact?: boolean;
}) {
	const ctx = useMe();
	const [fetched, setFetched] = useState<GroupSummary | null>(null);
	/** Set after a join that didn't navigate; overrides what we were given. */
	const [local, setLocal] = useState<GroupSummary | null>(null);
	const [open, setOpen] = useState(false);
	const [interest, setInterest] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = useId();

	const needFetch = given === undefined;
	useEffect(() => {
		setLocal(null);
		setFetched(null);
		if (!needFetch) return;
		let stop = false;
		api.eventGroup(eventId).then(
			(s) => !stop && setFetched(s),
			() => !stop && setFetched(null),
		);
		return () => {
			stop = true;
		};
	}, [eventId, needFetch]);

	const summary = local ?? given ?? fetched;

	if (!ctx || !summary) return null;
	const t = ctx.me.tagalong;
	if (t.suspended) return null;

	const count =
		summary.member_count === 0
			? "Nobody from Tagalong has joined this event's group yet."
			: `${summary.member_count} ${summary.member_count === 1 ? "person is" : "people are"} in this event's Tagalong group.`;

	if (summary.joined && summary.group_id) {
		const to = `/groups/${summary.group_id}`;
		return (
			<div className={compact ? "tg-whoelse compact" : "card tg-whoelse"}>
				{!compact && <h2>Tagalong</h2>}
				<p className="muted">{count}</p>
				<a className="button primary" href={to} onClick={linkTo(to)}>
					Open group
				</a>
			</div>
		);
	}

	const join = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const v = interest.trim();
			const joined = await api.joinGroup(eventId, v === "" ? null : v);
			if (joined.group_id) navigate(`/groups/${joined.group_id}`);
			else {
				setLocal(joined);
				setBusy(false);
			}
		} catch (err) {
			setError(
				err instanceof ApiError
					? err.status === 429
						? "You've joined a lot of groups today. Try again tomorrow."
						: err.message
					: "That didn't go through. Try again.",
			);
			setBusy(false);
		}
	};

	return (
		<div className={compact ? "tg-whoelse compact" : "card tg-whoelse"}>
			{!compact && <h2>Tagalong</h2>}
			<p className="muted">{count}</p>
			{!open ? (
				<button
					type="button"
					className={compact ? undefined : "primary"}
					onClick={() => setOpen(true)}
				>
					Who else is going?
				</button>
			) : !t.opted_in ? (
				<TagalongGate
					intro={<p className="muted">Opt in first, then you can join this event's group.</p>}
					onCancel={() => setOpen(false)}
				/>
			) : (
				<form onSubmit={join} className="tg-join">
					<label htmlFor={`${ids}-i`}>What are you up for? (optional)</label>
					<input
						id={`${ids}-i`}
						value={interest}
						maxLength={INTEREST_MAX}
						placeholder="e.g. pre-game food, sharing a ride"
						onChange={(e) => setInterest(e.target.value)}
						aria-describedby={`${ids}-n`}
						autoFocus
					/>
					<span id={`${ids}-n`} className="note">
						Group members see your Tagalong name ({t.name}), city ({t.city}) and this note.
					</span>
					{error && (
						<p className="error" role="alert">
							{error}
						</p>
					)}
					<div className="tg-actions">
						<button className="primary" disabled={busy}>
							{busy ? "Joining…" : "Join group"}
						</button>
						<button type="button" onClick={() => setOpen(false)}>
							Cancel
						</button>
					</div>
				</form>
			)}
		</div>
	);
}
