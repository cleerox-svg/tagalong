import type { ModAction, ModReport, ReportReason } from "@tagalong/shared";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { ErrorCard } from "./ErrorCard.js";
import { ConfirmDialog } from "./SafetyActions.js";

const REASON: Record<ReportReason, string> = {
	spam: "Spam or scam",
	harassment: "Harassment",
	safety: "Safety concern",
	inappropriate: "Inappropriate",
	other: "Other",
};

const when = (iso: string) =>
	new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const DONE: Record<ModAction, string> = {
	dismiss: "Report dismissed.",
	remove_message: "Message removed.",
	suspend_user: "User suspended.",
};

const errText = (err: unknown) =>
	err instanceof ApiError ? err.message : "That didn't go through. Try again.";

function ReportCard({
	r,
	onAction,
	onTrust,
	busy,
}: {
	r: ModReport;
	onAction: (a: ModAction) => void;
	onTrust: (userId: string) => void;
	busy: boolean;
}) {
	const m = r.message;
	const u = r.target_user;
	return (
		<li className="card tg-report">
			<p className="tg-report-head">
				<strong>{REASON[r.reason]}</strong>
				<span className="muted">
					{" "}
					· {r.target_type === "message" ? "message" : "user"} reported {when(r.created_at)} by{" "}
					{r.reporter.name ?? "a member"} <code>{r.reporter.user_id}</code>
				</span>
			</p>
			{r.details && (
				<p>
					<span className="muted">Reporter says: </span>
					{r.details}
				</p>
			)}
			{m && (
				<figure className="tg-quoted">
					<blockquote>{m.body}</blockquote>
					<figcaption className="muted">
						{m.author_name ?? "Unknown"} <code>{m.author_id}</code> ·{" "}
						{m.room_kind === "dm" ? "DM" : "group"} <code>{m.room_id}</code> · {when(m.created_at)}
						{m.deleted_at && (
							<>
								{" · "}
								<span className="badge est">
									deleted by {m.deleted_by ?? "someone"} {when(m.deleted_at)}
								</span>
							</>
						)}
					</figcaption>
				</figure>
			)}
			{u && (
				<p>
					<span className="muted">{m ? "Author" : "Reported user"}: </span>
					{u.name ?? "Unknown"}
					{u.city && ` · ${u.city}`} <code>{u.user_id}</code>
					{u.suspended && (
						<>
							{" "}
							<span className="badge est">suspended</span>
						</>
					)}
				</p>
			)}
			<div className="tg-actions">
				<button type="button" disabled={busy} onClick={() => onAction("dismiss")}>
					Dismiss
				</button>
				{m && !m.deleted_at && (
					<button type="button" disabled={busy} onClick={() => onAction("remove_message")}>
						Remove message
					</button>
				)}
				{u && !u.suspended && (
					<button
						type="button"
						className="danger"
						disabled={busy}
						onClick={() => onAction("suspend_user")}
					>
						Suspend user
					</button>
				)}
				{u && !u.suspended && (
					<button type="button" disabled={busy} onClick={() => onTrust(u.user_id)}>
						Mark user trusted
					</button>
				)}
			</div>
		</li>
	);
}

/** /mod — the open-report queue. The API enforces who is a moderator; this page only shows it. */
export function Moderation() {
	const [reports, setReports] = useState<ModReport[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [suspend, setSuspend] = useState<ModReport | null>(null);

	const load = useCallback(
		() =>
			api.modReports().then(
				(r) => {
					setReports(r.reports);
					setError(null);
				},
				(err: unknown) =>
					setError(
						err instanceof ApiError && err.status === 403
							? "Only moderators can see this page."
							: "We can't load the queue right now.",
					),
			),
		[],
	);
	useEffect(() => {
		void load();
	}, [load]);

	const resolve = async (r: ModReport, action: ModAction) => {
		setBusy(r.id);
		setNotice(null);
		try {
			await api.modResolve(r.id, action);
			setNotice(DONE[action]);
			await load();
		} catch (err) {
			setNotice(errText(err));
		} finally {
			setBusy(null);
		}
	};

	if (error) return <ErrorCard message={error} to="/" label="Budgetrip" />;
	if (!reports) return <p className="muted">Loading…</p>;

	return (
		<>
			<section className="card">
				<h1>Moderation</h1>
				<p className="muted">
					{reports.length} open report{reports.length === 1 ? "" : "s"}. Deleted messages are shown
					here so they can still be reviewed.
				</p>
				{notice && (
					<p className="tg-status" role="status">
						{notice}
					</p>
				)}
			</section>
			<ul className="tg-reports">
				{reports.map((r) => (
					<ReportCard
						key={r.id}
						r={r}
						busy={busy === r.id}
						onAction={(a) => (a === "suspend_user" ? setSuspend(r) : void resolve(r, a))}
						onTrust={async (uid) => {
							setBusy(r.id);
							setNotice(null);
							try {
								await api.modTrust(uid);
								setNotice("User trusted.");
							} catch (err) {
								setNotice(errText(err));
							} finally {
								setBusy(null);
							}
						}}
					/>
				))}
			</ul>
			{suspend && (
				<ConfirmDialog
					title={`Suspend ${suspend.target_user?.name ?? "this user"}?`}
					confirmLabel="Suspend"
					danger
					onClose={() => setSuspend(null)}
					onConfirm={async () => {
						await api.modResolve(suspend.id, "suspend_user");
						setNotice(DONE.suspend_user);
						await load();
					}}
				>
					<p>
						They'll be removed from every group, disconnected from chats, and unable to use
						Tagalong. Their trips aren't affected.
					</p>
				</ConfirmDialog>
			)}
		</>
	);
}
