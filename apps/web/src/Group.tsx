import { INTEREST_MAX, type GroupDetail, type GroupMember } from "@tagalong/shared";
import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError } from "./api.js";
import { ChatPanel, linkTo } from "./Dm.js";
import { navigate } from "./router.js";
import { ConfirmDialog, PersonActions } from "./SafetyActions.js";

export function eventDate(e: GroupDetail["event"]): string | null {
	if (e.local_date) return e.local_date;
	if (e.starts_at)
		return new Date(e.starts_at).toLocaleDateString(undefined, { dateStyle: "medium" });
	return null;
}

function MyInterest({
	groupId,
	member,
	onSaved,
}: {
	groupId: string;
	member: GroupMember;
	onSaved: () => void;
}) {
	const [value, setValue] = useState(member.interest ?? "");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
	const id = useId();
	return (
		<form
			className="tg-interest"
			onSubmit={async (e) => {
				e.preventDefault();
				setBusy(true);
				setMsg(null);
				try {
					const v = value.trim();
					await api.setInterest(groupId, v === "" ? null : v);
					setMsg({ ok: true, text: "Saved." });
					onSaved();
				} catch (err) {
					setMsg({
						ok: false,
						text: err instanceof ApiError ? err.message : "That didn't save. Try again.",
					});
				} finally {
					setBusy(false);
				}
			}}
		>
			<label>
				What you're up for (optional)
				<input
					value={value}
					maxLength={INTEREST_MAX}
					placeholder="e.g. pre-game food, sharing a ride"
					onChange={(e) => setValue(e.target.value)}
					aria-describedby={`${id}-n`}
				/>
				<span id={`${id}-n`} className="note">
					Shown to everyone in this group. {value.length}/{INTEREST_MAX}
				</span>
			</label>
			<button disabled={busy}>{busy ? "Saving…" : "Save"}</button>
			{msg && (
				<span className={msg.ok ? "tg-status" : "error"} role={msg.ok ? "status" : "alert"}>
					{msg.text}
				</span>
			)}
		</form>
	);
}

/** /groups/:id — an event's Tagalong group: who's going, and the group chat. */
export function Group({ id }: { id: string }) {
	const [group, setGroup] = useState<GroupDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [leaving, setLeaving] = useState(false);

	const load = useCallback(
		() =>
			api
				.group(id)
				.then(setGroup, (err: unknown) =>
					setError(
						err instanceof ApiError && err.status === 404
							? "This group isn't available. You may have left it, or it no longer exists."
							: "We can't load this group right now.",
					),
				),
		[id],
	);
	useEffect(() => {
		void load();
	}, [load]);

	if (error)
		return (
			<section className="card">
				<p className="error">{error}</p>
				<a href="/connections" onClick={linkTo("/connections")}>
					← Tagalong
				</a>
			</section>
		);
	if (!group) return <p className="muted">Loading…</p>;

	const me = group.members.find((m) => m.is_me);
	const others = group.members.filter((m) => !m.is_me);
	const date = eventDate(group.event);
	const dropMember = (uid: string) =>
		setGroup((g) => (g ? { ...g, members: g.members.filter((m) => m.user_id !== uid) } : g));

	return (
		<>
			<section className="card">
				<p className="muted tg-kicker">Tagalong group</p>
				<h1>{group.event.name}</h1>
				<p className="muted">
					{[date, group.event.city].filter(Boolean).join(" · ")}
					{" · "}
					{group.members.length} {group.members.length === 1 ? "person" : "people"} going
				</p>
				{me && <MyInterest groupId={group.group_id} member={me} onSaved={() => void load()} />}
				<button type="button" onClick={() => setLeaving(true)}>
					Leave group
				</button>
			</section>

			<section className="card">
				<h2>Who's going</h2>
				{others.length === 0 && (
					<p className="muted">Nobody else has joined yet. Check back closer to the date.</p>
				)}
				<ul className="tg-members">
					{others.map((m) => (
						<li key={m.user_id}>
							<div>
								<a href={`/people/${m.user_id}`} onClick={linkTo(`/people/${m.user_id}`)}>
									<strong>{m.name}</strong>
								</a>{" "}
								<span className="muted">· {m.city}</span>
								{m.interest && <p className="tg-interest-text">{m.interest}</p>}
							</div>
							<PersonActions userId={m.user_id} name={m.name} onBlocked={dropMember} />
						</li>
					))}
				</ul>
				<p className="note">
					Members only ever see each other's chosen name and city. Meet in public places.
				</p>
			</section>

			<ChatPanel kind="group" id={group.group_id} onBlocked={dropMember} />

			{leaving && (
				<ConfirmDialog
					title="Leave this group?"
					confirmLabel="Leave group"
					onClose={() => setLeaving(false)}
					onConfirm={async () => {
						await api.leaveGroup(group.group_id);
						navigate("/connections");
					}}
				>
					<p>You'll stop seeing the group chat. You can join again from your trip.</p>
				</ConfirmDialog>
			)}
		</>
	);
}
