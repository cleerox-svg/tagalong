/**
 * Tagalong safety UI (spec §6): accessible modal dialogs, the report and
 * block flows, and the "meet in public places" note shown before anyone's
 * first connect.
 */
import {
	REPORT_DETAILS_MAX,
	REPORT_REASONS,
	type Connection,
	type ReportReason,
} from "@tagalong/shared";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { useMe } from "./TagalongGate.js";
import { PushOffer, usePushOffer } from "./PushOffer.js";

const errText = (err: unknown) =>
	err instanceof ApiError
		? err.status === 429
			? "You've done that too many times today. Try again later."
			: err.message
		: "That didn't go through. Check your connection and try again.";

/**
 * Put focus back after a dialog closes: on the element that opened it when
 * that's still on the page; otherwise (the row it lived in was removed, say)
 * on the opener's section — its `[data-focus-return]` element, else its
 * heading — or the page heading. Leaves focus alone if something else has
 * already taken it.
 */
export function restoreFocus(opener: HTMLElement | null, region: HTMLElement | null): void {
	const active = document.activeElement;
	if (active && active !== document.body && active.isConnected && active !== opener) return;
	if (opener?.isConnected) {
		opener.focus();
		if (document.activeElement === opener) return;
	}
	const scope = region?.isConnected ? region : null;
	const target =
		scope?.querySelector<HTMLElement>("[data-focus-return]") ??
		scope?.querySelector<HTMLElement>("h1, h2") ??
		document.querySelector<HTMLElement>("main h1, main h2");
	if (!target) return;
	if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
	target.focus();
}

/**
 * A native modal `<dialog>`: focus moves in on open, is trapped while open,
 * Escape closes it, and focus returns to whatever opened it (or a sensible
 * fallback when that's gone; see restoreFocus).
 */
export function Modal({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const id = useId();
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		const active = document.activeElement;
		const opener = active instanceof HTMLElement && active !== document.body ? active : null;
		const region = opener?.closest<HTMLElement>("section, main") ?? null;
		if (!d.open) {
			if (typeof d.showModal === "function") d.showModal();
			else d.setAttribute("open", "");
		}
		return () => {
			if (d.open) d.close();
			// After the commit that closed us settles: the opener may have gone with it.
			setTimeout(() => restoreFocus(opener, region), 0);
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className="tg-dialog"
			aria-labelledby={`${id}-t`}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
		>
			<h2 id={`${id}-t`}>{title}</h2>
			{children}
		</dialog>
	);
}

/** Yes/no confirmation for anything consequential. */
export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	danger,
	onConfirm,
	onClose,
}: {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	danger?: boolean;
	/** Throw to show an error and keep the dialog open. */
	onConfirm: () => Promise<void>;
	onClose: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Modal title={title} onClose={onClose}>
			{children}
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			<div className="tg-dialog-actions">
				<button type="button" onClick={onClose} autoFocus>
					Cancel
				</button>
				<button
					type="button"
					className={danger ? "danger" : "primary"}
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setError(null);
						try {
							await onConfirm();
							onClose();
						} catch (err) {
							setError(errText(err));
							setBusy(false);
						}
					}}
				>
					{busy ? "Working…" : confirmLabel}
				</button>
			</div>
		</Modal>
	);
}

const REASON_TEXT: Record<ReportReason, string> = {
	spam: "Spam or scam",
	harassment: "Harassment or bullying",
	safety: "I'm worried about someone's safety",
	inappropriate: "Inappropriate or offensive",
	other: "Something else",
};

export interface ReportTarget {
	type: "message" | "user";
	id: string;
	/** What is being reported, for the dialog title ("Dana's message"). */
	label: string;
}

export function ReportDialog({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
	const [reason, setReason] = useState<ReportReason | "">("");
	const [details, setDetails] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const id = useId();

	if (done)
		return (
			<Modal title="Thanks for telling us" onClose={onClose}>
				<p>
					A moderator will look at this. The person you reported isn't told who reported them. If
					someone is in danger right now, contact local emergency services.
				</p>
				<div className="tg-dialog-actions">
					<button type="button" className="primary" onClick={onClose} autoFocus>
						Close
					</button>
				</div>
			</Modal>
		);

	return (
		<Modal title={`Report ${target.label}`} onClose={onClose}>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					if (!reason) return setError("Choose a reason.");
					setBusy(true);
					setError(null);
					try {
						const d = details.trim();
						await api.report({
							target_type: target.type,
							target_id: target.id,
							reason,
							...(d ? { details: d } : {}),
						});
						setDone(true);
					} catch (err) {
						setError(errText(err));
					} finally {
						setBusy(false);
					}
				}}
			>
				<label>
					Reason
					<select
						value={reason}
						onChange={(e) => setReason(e.target.value as ReportReason)}
						autoFocus
						required
					>
						<option value="">Choose a reason…</option>
						{REPORT_REASONS.map((r) => (
							<option key={r} value={r}>
								{REASON_TEXT[r]}
							</option>
						))}
					</select>
				</label>
				<label>
					Anything else a moderator should know? (optional)
					<textarea
						rows={3}
						value={details}
						maxLength={REPORT_DETAILS_MAX}
						onChange={(e) => setDetails(e.target.value)}
						aria-describedby={`${id}-count`}
					/>
					<span id={`${id}-count`} className="note">
						{details.length}/{REPORT_DETAILS_MAX}
					</span>
				</label>
				{error && (
					<p className="error" role="alert">
						{error}
					</p>
				)}
				<div className="tg-dialog-actions">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button className="primary" disabled={busy}>
						{busy ? "Sending…" : "Send report"}
					</button>
				</div>
			</form>
		</Modal>
	);
}

export function BlockDialog({
	userId,
	name,
	onClose,
	onBlocked,
}: {
	userId: string;
	name: string;
	onClose: () => void;
	onBlocked?: (userId: string) => void | Promise<void>;
}) {
	return (
		<ConfirmDialog
			title={`Block ${name}?`}
			confirmLabel="Block"
			danger
			onClose={onClose}
			onConfirm={async () => {
				await api.block(userId);
				await onBlocked?.(userId);
			}}
		>
			<p>
				You won't see each other anywhere in Tagalong — not in groups, chats or messages — and any
				connection between you is closed. They aren't told. You can unblock them later from the
				Tagalong page.
			</p>
		</ConfirmDialog>
	);
}

/** Shown once, before a user's first connect (or accept). */
export function SafetyNoteDialog({
	onAck,
	onClose,
}: {
	onAck: () => Promise<void>;
	onClose: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Modal title="Before you meet anyone" onClose={onClose}>
			<ul className="tg-points">
				<li>
					<strong>Meet in public places</strong> with other people around, like the venue, a café or
					a busy bar.
				</li>
				<li>Tell a friend or family member who you're meeting, where and when.</li>
				<li>Arrange your own way there and back.</li>
				<li>Don't share your address, financial details or ID. Never send money.</li>
				<li>Trust your instincts. If something feels wrong, leave, then block and report.</li>
			</ul>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			<div className="tg-dialog-actions">
				<button type="button" onClick={onClose}>
					Not now
				</button>
				<button
					type="button"
					className="primary"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						setError(null);
						try {
							await onAck();
						} catch (err) {
							setError(errText(err));
							setBusy(false);
						}
					}}
				>
					{busy ? "Saving…" : "I understand"}
				</button>
			</div>
		</Modal>
	);
}

/**
 * Wrap an action that needs the safety note acknowledged first (connect,
 * accept). Shows the note if the user hasn't acked it yet — or if the server
 * says so (409 safety_ack_required) — then runs the action.
 */
export function useSafetyGate(): {
	run: (action: () => Promise<void>) => Promise<void>;
	dialog: ReactNode;
} {
	const ctx = useMe();
	const [pending, setPending] = useState<(() => Promise<void>) | null>(null);

	const run = useCallback(
		async (action: () => Promise<void>) => {
			if (!ctx?.me.tagalong.safety_acked) {
				setPending(() => action);
				return;
			}
			try {
				await action();
			} catch (err) {
				if (err instanceof ApiError && err.code === "safety_ack_required") setPending(() => action);
				else throw err;
			}
		},
		[ctx],
	);

	const dialog = pending ? (
		<SafetyNoteDialog
			onClose={() => setPending(null)}
			onAck={async () => {
				await api.safetyAck();
				await ctx?.reload();
				const action = pending;
				setPending(null);
				await action().catch(() => undefined);
			}}
		/>
	) : null;

	return { run, dialog };
}

type ConnectResult = "pending" | "accepted" | "failed";

const CONNECT_STATUS: Record<ConnectResult, string> = {
	pending: "Request sent.",
	accepted: "Connected — you can message each other now.",
	failed: "Couldn't send a request.",
};

/**
 * Connect / Block / Report for another person (a group member row, a
 * profile, a connection row). Connect goes through the safety gate; once
 * used, its slot stays as a disabled "Requested" / "Connected" button so
 * focus and layout don't jump.
 */
export function PersonActions({
	userId,
	name,
	canConnect = true,
	onBlocked,
	onConnected,
}: {
	userId: string;
	name: string;
	canConnect?: boolean;
	onBlocked?: (userId: string) => void | Promise<void>;
	onConnected?: (connection: Connection) => void;
}) {
	const [open, setOpen] = useState<"block" | "report" | null>(null);
	const [result, setResult] = useState<ConnectResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const gate = useSafetyGate();
	const push = usePushOffer();

	const connect = () =>
		gate.run(async () => {
			setBusy(true);
			setError(null);
			try {
				const res = await api.connect(userId);
				const status = res?.connection?.status;
				setResult(status === "pending" || status === "accepted" ? status : "failed");
				if (res?.connection) {
					push.offer();
					onConnected?.(res.connection);
				}
			} catch (err) {
				if (err instanceof ApiError && err.code === "safety_ack_required") throw err;
				setError(errText(err));
			} finally {
				setBusy(false);
			}
		});

	const slotText =
		result === "pending" ? "Requested" : result === "accepted" ? "Connected" : "Connect";
	// aria-disabled (not disabled) so a focused button keeps focus when it flips.
	const slotOff = busy || result !== null;

	return (
		<div className="tg-actions">
			{(canConnect || result) && (
				<button
					type="button"
					className={result ? undefined : "primary"}
					aria-disabled={slotOff || undefined}
					onClick={() => {
						if (!slotOff) void connect().catch(() => undefined);
					}}
					aria-label={`${slotText}${result ? ":" : " with"} ${name}`}
				>
					{busy ? "Sending…" : slotText}
				</button>
			)}
			<button type="button" onClick={() => setOpen("block")} aria-label={`Block ${name}`}>
				Block
			</button>
			<button type="button" onClick={() => setOpen("report")} aria-label={`Report ${name}`}>
				Report
			</button>
			{result && (
				<span className={result === "failed" ? "muted" : "tg-status"} role="status">
					{CONNECT_STATUS[result]}
				</span>
			)}
			{error && (
				<span className="error" role="alert">
					{error}
				</span>
			)}
			{open === "block" && (
				<BlockDialog
					userId={userId}
					name={name}
					onClose={() => setOpen(null)}
					{...(onBlocked ? { onBlocked } : {})}
				/>
			)}
			{open === "report" && (
				<ReportDialog
					target={{ type: "user", id: userId, label: name }}
					onClose={() => setOpen(null)}
				/>
			)}
			<PushOffer
				state={push}
				question={
					result === "accepted"
						? `Get a notification when ${name} messages you?`
						: `Get a notification when ${name} answers?`
				}
			/>
			{gate.dialog}
		</div>
	);
}
