import {
	containsUrl,
	MESSAGE_BODY_MAX,
	type ChatMessage,
	type Connection,
	type RoomKind,
} from "@tagalong/shared";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { useChat } from "./chat.js";
import { navigate } from "./router.js";
import { BlockDialog, ConfirmDialog, ReportDialog } from "./SafetyActions.js";
import { useMe } from "./TagalongGate.js";

export const linkTo = (to: string) => (e: React.MouseEvent) => {
	e.preventDefault();
	navigate(to);
};

const time = (iso: string) => {
	const d = new Date(iso);
	const sameDay = d.toDateString() === new Date().toDateString();
	return d.toLocaleString(
		undefined,
		sameDay ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" },
	);
};

type MessageDialog = { kind: "report" | "block" | "delete"; message: ChatMessage } | null;

function MessageRow({
	m,
	onAction,
}: {
	m: ChatMessage;
	onAction: (kind: "report" | "block" | "delete") => void;
}) {
	const [open, setOpen] = useState(false);
	const menuId = useId();
	return (
		<li className={m.is_me ? "tg-msg mine" : "tg-msg"}>
			<div className="tg-msg-head">
				<span className="tg-msg-name">
					{m.is_me ? (
						"You"
					) : (
						<a href={`/people/${m.user_id}`} onClick={linkTo(`/people/${m.user_id}`)}>
							{m.name}
						</a>
					)}
				</span>
				<time className="muted" dateTime={m.created_at}>
					{time(m.created_at)}
				</time>
				<button
					type="button"
					className="tg-more"
					aria-expanded={open}
					aria-controls={menuId}
					aria-label={m.is_me ? "Options for your message" : `Options for ${m.name}'s message`}
					onClick={() => setOpen((o) => !o)}
				>
					⋯
				</button>
			</div>
			<p className="tg-msg-body">{m.body}</p>
			{open && (
				<div id={menuId} className="tg-actions">
					{m.is_me ? (
						<button type="button" onClick={() => onAction("delete")}>
							Delete
						</button>
					) : (
						<>
							<button type="button" onClick={() => onAction("report")}>
								Report message
							</button>
							<button type="button" onClick={() => onAction("block")}>
								Block {m.name}
							</button>
						</>
					)}
				</div>
			)}
		</li>
	);
}

/** A chat room (group or DM): the message log, per-message safety actions, and the send box. */
export function ChatPanel({
	kind,
	id,
	onBlocked,
}: {
	kind: RoomKind;
	id: string;
	onBlocked?: (userId: string) => void;
}) {
	const chat = useChat(kind, id);
	const ctx = useMe();
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [dialog, setDialog] = useState<MessageDialog>(null);
	const logRef = useRef<HTMLDivElement>(null);
	const nearBottom = useRef(true);
	const ids = useId();

	// Stay pinned to the newest message unless the reader has scrolled up.
	useLayoutEffect(() => {
		const el = logRef.current;
		if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
	}, [chat.messages]);

	const newAccount = ctx ? !ctx.me.tagalong.trusted : false;
	const linkWarning = newAccount && containsUrl(draft);

	const send = async () => {
		const body = draft.trim();
		if (!body || sending || linkWarning) return;
		setSending(true);
		nearBottom.current = true;
		if (await chat.send(body)) setDraft("");
		setSending(false);
	};

	return (
		<section className="card tg-chat" aria-labelledby={`${ids}-h`}>
			<div className="tg-chat-head">
				<h2 id={`${ids}-h`}>{kind === "group" ? "Group chat" : "Messages"}</h2>
				<span className="muted tg-conn">
					{chat.connection === "live"
						? "Live"
						: chat.connection === "connecting"
							? "Connecting…"
							: "Reconnecting — checking every few seconds"}
				</span>
			</div>
			<div
				className="tg-log"
				ref={logRef}
				tabIndex={0}
				aria-label="Chat messages"
				onScroll={(e) => {
					const el = e.currentTarget;
					nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				{chat.hasOlder && (
					<button type="button" className="tg-older" onClick={() => void chat.loadOlder()}>
						Load earlier messages
					</button>
				)}
				{!chat.loaded && <p className="muted">Loading messages…</p>}
				{chat.loaded && chat.messages.length === 0 && (
					<p className="muted">No messages yet. Say hello!</p>
				)}
				<ol className="tg-msgs" aria-live="polite" aria-relevant="additions">
					{chat.messages.map((m) => (
						<MessageRow key={m.id} m={m} onAction={(k) => setDialog({ kind: k, message: m })} />
					))}
				</ol>
			</div>
			{chat.error && (
				<p className="error" role="alert">
					{chat.error}
				</p>
			)}
			<form
				className="tg-send"
				onSubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				<label htmlFor={`${ids}-box`} className="tg-send-label">
					Write a message
				</label>
				<textarea
					id={`${ids}-box`}
					rows={2}
					value={draft}
					maxLength={MESSAGE_BODY_MAX}
					onChange={(e) => {
						setDraft(e.target.value);
						if (chat.error) chat.clearError();
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							void send();
						}
					}}
					aria-describedby={`${ids}-hint${linkWarning ? ` ${ids}-link` : ""}`}
				/>
				<span id={`${ids}-hint`} className="note">
					Enter to send, Shift+Enter for a new line. Be kind; anyone can report a message.
				</span>
				{linkWarning && (
					<span id={`${ids}-link`} className="field-error">
						New accounts can't post links or e-mail addresses yet. Remove it to send.
					</span>
				)}
				<button className="primary" disabled={sending || !draft.trim() || linkWarning}>
					{sending ? "Sending…" : "Send"}
				</button>
			</form>

			{dialog?.kind === "report" && (
				<ReportDialog
					target={{
						type: "message",
						id: dialog.message.id,
						label: `${dialog.message.name}'s message`,
					}}
					onClose={() => setDialog(null)}
				/>
			)}
			{dialog?.kind === "block" && (
				<BlockDialog
					userId={dialog.message.user_id}
					name={dialog.message.name}
					onClose={() => setDialog(null)}
					onBlocked={(uid) => {
						chat.hideAuthor(uid);
						onBlocked?.(uid);
					}}
				/>
			)}
			{dialog?.kind === "delete" && (
				<ConfirmDialog
					title="Delete your message?"
					confirmLabel="Delete"
					danger
					onClose={() => setDialog(null)}
					onConfirm={() => chat.remove(dialog.message.id)}
				>
					<p>It disappears for everyone in this chat.</p>
				</ConfirmDialog>
			)}
		</section>
	);
}

/** /dm/:connectionId — a private chat with an accepted connection. */
export function Dm({ connectionId }: { connectionId: string }) {
	const [conn, setConn] = useState<Connection | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<"close" | "block" | "report" | null>(null);

	useEffect(() => {
		let stop = false;
		api.connections().then(
			(r) => {
				if (!stop) setConn(r.connections.find((c) => c.id === connectionId) ?? null);
			},
			(err: unknown) => {
				if (!stop)
					setError(err instanceof ApiError ? err.message : "We can't load this conversation.");
			},
		);
		return () => {
			stop = true;
		};
	}, [connectionId]);

	if (error) return <p className="error">{error}</p>;
	if (conn === undefined) return <p className="muted">Loading…</p>;
	if (!conn || conn.status !== "accepted")
		return (
			<section className="card">
				<h1>This conversation isn't open</h1>
				<p>Messages only work while you're both connected.</p>
				<a href="/connections" onClick={linkTo("/connections")}>
					← Back to Tagalong
				</a>
			</section>
		);

	const back = () => navigate("/connections");

	return (
		<>
			<section className="card">
				<p>
					<a href="/connections" onClick={linkTo("/connections")}>
						← Tagalong
					</a>
				</p>
				<h1>
					<a
						href={`/people/${conn.other_user_id}`}
						onClick={linkTo(`/people/${conn.other_user_id}`)}
					>
						{conn.other_name}
					</a>
				</h1>
				<p className="muted">{conn.other_city}</p>
				<div className="tg-actions">
					<button type="button" onClick={() => setDialog("close")}>
						End connection
					</button>
					<button type="button" onClick={() => setDialog("block")}>
						Block
					</button>
					<button type="button" onClick={() => setDialog("report")}>
						Report
					</button>
				</div>
				<p className="note">
					Meet in public places, tell someone where you're going, and never send money.
				</p>
			</section>
			<ChatPanel kind="dm" id={conn.id} onBlocked={back} />
			{dialog === "close" && (
				<ConfirmDialog
					title={`End your connection with ${conn.other_name}?`}
					confirmLabel="End connection"
					onClose={() => setDialog(null)}
					onConfirm={async () => {
						await api.closeConnection(conn.id);
						back();
					}}
				>
					<p>Neither of you will be able to send messages here. You can connect again later.</p>
				</ConfirmDialog>
			)}
			{dialog === "block" && (
				<BlockDialog
					userId={conn.other_user_id}
					name={conn.other_name}
					onClose={() => setDialog(null)}
					onBlocked={back}
				/>
			)}
			{dialog === "report" && (
				<ReportDialog
					target={{ type: "user", id: conn.other_user_id, label: conn.other_name }}
					onClose={() => setDialog(null)}
				/>
			)}
		</>
	);
}
