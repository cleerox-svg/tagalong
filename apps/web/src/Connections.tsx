import type { BlockedUser, Connection, TagalongProfile } from "@tagalong/shared";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { BackLink, ErrorCard } from "./ErrorCard.js";
import { linkTo } from "./router.js";
import { ConfirmDialog, PersonActions, useSafetyGate } from "./SafetyActions.js";
import { useMe } from "./TagalongGate.js";
import { askForPushInContext } from "./native.js";

const errText = (err: unknown) =>
	err instanceof ApiError ? err.message : "That didn't go through. Try again.";

function Person({ c }: { c: Connection }) {
	return (
		<div>
			<a href={`/people/${c.other_user_id}`} onClick={linkTo(`/people/${c.other_user_id}`)}>
				<strong>{c.other_name}</strong>
			</a>{" "}
			<span className="muted">· {c.other_city}</span>
		</div>
	);
}

/** /connections — the Tagalong hub: requests, connections, blocked people, and leaving. */
export function Connections() {
	const ctx = useMe();
	const [conns, setConns] = useState<Connection[] | null>(null);
	const [blocks, setBlocks] = useState<BlockedUser[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<
		{ kind: "close"; c: Connection } | { kind: "optout" } | null
	>(null);
	const gate = useSafetyGate();

	const load = useCallback(async () => {
		try {
			const [c, b] = await Promise.all([api.connections(), api.blocks()]);
			setConns(c.connections);
			setBlocks(b.blocks);
		} catch {
			setError("We can't load your Tagalong connections right now.");
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const act = async (key: string, fn: () => Promise<unknown>) => {
		setBusy(key);
		setActionError(null);
		try {
			await fn();
			await load();
		} catch (err) {
			if (err instanceof ApiError && err.code === "safety_ack_required") throw err;
			setActionError(errText(err));
		} finally {
			setBusy(null);
		}
	};

	if (!ctx) return null;
	if (error)
		return (
			<ErrorCard message={error} to="/trips" label="My trips">
				<p>
					<button
						type="button"
						onClick={() => {
							setError(null);
							void load();
						}}
					>
						Try again
					</button>
				</p>
			</ErrorCard>
		);
	if (!conns || !blocks) return <p className="muted">Loading…</p>;

	const incoming = conns.filter((c) => c.status === "pending" && !c.requested_by_me);
	const outgoing = conns.filter((c) => c.status === "pending" && c.requested_by_me);
	const accepted = conns.filter((c) => c.status === "accepted");
	const t = ctx.me.tagalong;
	/** Block / Report on a row; blocking closes the connection, so re-read the lists. */
	const safety = (c: Connection) => (
		<PersonActions
			userId={c.other_user_id}
			name={c.other_name}
			canConnect={false}
			onBlocked={load}
		/>
	);

	return (
		<>
			<section className="card">
				<h1>Tagalong</h1>
				<p className="muted">
					You appear to others as <strong>{t.name}</strong> from <strong>{t.city}</strong>.
				</p>
				<p className="note">
					Find people going to the same event from a trip: open a plan or a saved trip and choose{" "}
					<em>Who else is going?</em>
				</p>
				{!t.trusted && (
					<p className="note">
						Your account is new, so for now you can send fewer messages and connect requests, and
						can't post links.
					</p>
				)}
				{actionError && (
					<p className="error" role="alert">
						{actionError}
					</p>
				)}
			</section>

			<section className="card">
				<h2>Requests for you</h2>
				{incoming.length === 0 && <p className="muted">No requests right now.</p>}
				<ul className="tg-members">
					{incoming.map((c) => (
						<li key={c.id}>
							<Person c={c} />
							<div className="tg-actions">
								<button
									type="button"
									className="primary"
									disabled={busy === c.id}
									aria-label={`Accept ${c.other_name}`}
									onClick={() =>
										void gate
											.run(() =>
												act(c.id, async () => {
													const res = await api.acceptConnection(c.id);
													askForPushInContext();
													return res;
												}),
											)
											.catch((err: unknown) => setActionError(errText(err)))
									}
								>
									Accept
								</button>
								<button
									type="button"
									disabled={busy === c.id}
									aria-label={`Decline ${c.other_name}`}
									onClick={() => void act(c.id, () => api.declineConnection(c.id))}
								>
									Decline
								</button>
							</div>
							{safety(c)}
						</li>
					))}
				</ul>
			</section>

			<section className="card">
				<h2>Connected</h2>
				{accepted.length === 0 && (
					<p className="muted">
						Once you and someone else both connect, you can message each other here.
					</p>
				)}
				<ul className="tg-members">
					{accepted.map((c) => (
						<li key={c.id}>
							<Person c={c} />
							<div className="tg-actions">
								<a className="button primary" href={`/dm/${c.id}`} onClick={linkTo(`/dm/${c.id}`)}>
									Message
								</a>
								<button
									type="button"
									aria-label={`End connection with ${c.other_name}`}
									onClick={() => setConfirm({ kind: "close", c })}
								>
									End
								</button>
							</div>
							{safety(c)}
						</li>
					))}
				</ul>
			</section>

			{outgoing.length > 0 && (
				<section className="card">
					<h2>Waiting for a reply</h2>
					<ul className="tg-members">
						{outgoing.map((c) => (
							<li key={c.id}>
								<Person c={c} />
								<button
									type="button"
									disabled={busy === c.id}
									aria-label={`Cancel request to ${c.other_name}`}
									onClick={() => void act(c.id, () => api.closeConnection(c.id))}
								>
									Cancel request
								</button>
								{safety(c)}
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="card">
				<h2>Blocked</h2>
				{blocks.length === 0 && <p className="muted">You haven't blocked anyone.</p>}
				<ul className="tg-members">
					{blocks.map((b) => (
						<li key={b.user_id}>
							<div>{b.name ?? "A Tagalong member"}</div>
							<button
								type="button"
								disabled={busy === b.user_id}
								aria-label={`Unblock ${b.name ?? "this member"}`}
								onClick={() => void act(b.user_id, () => api.unblock(b.user_id))}
							>
								Unblock
							</button>
						</li>
					))}
				</ul>
			</section>

			<section className="card">
				<h2>Leave Tagalong</h2>
				<p className="muted">
					You'll leave every group and stop appearing to anyone. Your trips aren't affected.
				</p>
				<button type="button" className="danger" onClick={() => setConfirm({ kind: "optout" })}>
					Leave Tagalong
				</button>
			</section>

			{confirm?.kind === "close" && (
				<ConfirmDialog
					title={`End your connection with ${confirm.c.other_name}?`}
					confirmLabel="End connection"
					onClose={() => setConfirm(null)}
					onConfirm={async () => {
						await api.closeConnection(confirm.c.id);
						await load();
					}}
				>
					<p>Neither of you will be able to send messages. You can connect again later.</p>
				</ConfirmDialog>
			)}
			{confirm?.kind === "optout" && (
				<ConfirmDialog
					title="Leave Tagalong?"
					confirmLabel="Leave Tagalong"
					danger
					onClose={() => setConfirm(null)}
					onConfirm={async () => {
						await api.tagalongOptOut();
						await ctx.reload();
					}}
				>
					<p>
						You'll leave all your event groups and nobody will see you in Tagalong. You can join
						again later.
					</p>
				</ConfirmDialog>
			)}
			{gate.dialog}
		</>
	);
}

const CONN_TEXT: Record<string, string> = {
	pending: "Connection request pending",
	accepted: "You're connected",
	declined: "Not connected",
	closed: "Not connected",
};

/** /people/:id — what you can see of another member: name, city, groups you share. */
export function Profile({ userId }: { userId: string }) {
	const [p, setP] = useState<TagalongProfile | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [blocked, setBlocked] = useState(false);

	useEffect(() => {
		let stop = false;
		setP(null);
		setError(null);
		setBlocked(false);
		api.profile(userId).then(
			(r) => !stop && setP(r),
			(err: unknown) =>
				!stop &&
				setError(
					err instanceof ApiError && err.status === 404
						? "This person isn't available."
						: "We can't load this profile right now.",
				),
		);
		return () => {
			stop = true;
		};
	}, [userId]);

	if (error) return <ErrorCard message={error} />;
	if (!p || p.user_id !== userId) return <p className="muted">Loading…</p>;
	if (blocked)
		return (
			<section className="card">
				<p>You've blocked {p.name}. You can unblock them from the Tagalong page.</p>
				<BackLink />
			</section>
		);

	/** Reflect a connect straight away, without re-reading the profile. */
	const connected = (c: Connection) =>
		setP((cur) =>
			cur && cur.user_id === c.other_user_id
				? {
						...cur,
						connection_id: c.id,
						connection_status: c.status,
						requested_by_me: c.requested_by_me,
					}
				: cur,
		);

	return (
		<section className="card">
			<h1>{p.name}</h1>
			<p className="muted">{p.city}</p>
			{!p.is_me && (
				<p>
					{p.connection_status ? CONN_TEXT[p.connection_status] : "Not connected"}
					{p.connection_status === "pending" &&
						(p.requested_by_me ? " (you asked)" : " (they asked)")}
					{p.connection_status === "accepted" && p.connection_id && (
						<>
							{" · "}
							<a href={`/dm/${p.connection_id}`} onClick={linkTo(`/dm/${p.connection_id}`)}>
								Message
							</a>
						</>
					)}
					{p.connection_status === "pending" && !p.requested_by_me && (
						<>
							{" · "}
							<a href="/connections" onClick={linkTo("/connections")}>
								Respond
							</a>
						</>
					)}
				</p>
			)}
			{p.shared_groups.length > 0 && (
				<>
					<h2>Groups you share</h2>
					<ul className="tg-list">
						{p.shared_groups.map((g) => (
							<li key={g.group_id}>
								<a href={`/groups/${g.group_id}`} onClick={linkTo(`/groups/${g.group_id}`)}>
									{g.event_name}
								</a>
								{g.starts_at && (
									<span className="muted">
										{" "}
										· {new Date(g.starts_at).toLocaleDateString(undefined, { dateStyle: "medium" })}
									</span>
								)}
							</li>
						))}
					</ul>
				</>
			)}
			{!p.is_me && (
				<PersonActions
					key={p.user_id}
					userId={p.user_id}
					name={p.name}
					canConnect={
						p.connection_status === null ||
						p.connection_status === "declined" ||
						p.connection_status === "closed"
					}
					onBlocked={() => setBlocked(true)}
					onConnected={connected}
				/>
			)}
		</section>
	);
}
