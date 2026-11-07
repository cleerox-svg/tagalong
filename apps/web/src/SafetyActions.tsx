/**
 * Tagalong safety UI (spec §6): accessible modal dialogs, the report and
 * block flows, and the "meet in public places" note shown before anyone's
 * first connect.
 */
import { REPORT_DETAILS_MAX, REPORT_REASONS, type ReportReason } from "@tagalong/shared";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { useMe } from "./TagalongGate.js";

const errText = (err: unknown) =>
	err instanceof ApiError
		? err.status === 429
			? "You've done that too many times today. Try again later."
			: err.message
		: "That didn't go through. Check your connection and try again.";

/**
 * A native modal `<dialog>`: focus moves in on open, is trapped while open,
 * Escape closes it, and focus returns to whatever opened it.
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
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (!d.open) {
			if (typeof d.showModal === "function") d.showModal();
			else d.setAttribute("open", "");
		}
		return () => {
			if (d.open) d.close();
			opener?.focus();
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
	onBlocked?: (userId: string) => void;
}) {
	return (
		<ConfirmDialog
			title={`Block ${name}?`}
			confirmLabel="Block"
			danger
			onClose={onClose}
			onConfirm={async () => {
				await api.block(userId);
				onBlocked?.(userId);
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
					autoFocus
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

/**
 * Connect / Block / Report for another person (a group member row or a
 * profile). Connect goes through the safety gate.
 */
export function PersonActions({
	userId,
	name,
	canConnect = true,
	onBlocked,
}: {
	userId: string;
	name: string;
	canConnect?: boolean;
	onBlocked?: (userId: string) => void;
}) {
	const [open, setOpen] = useState<"block" | "report" | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const gate = useSafetyGate();

	const connect = () =>
		gate.run(async () => {
			setBusy(true);
			setError(null);
			try {
				const res = await api.connect(userId);
				setStatus(
					res?.connection?.status === "accepted"
						? "Connected — you can message each other now."
						: "Request sent.",
				);
			} catch (err) {
				if (err instanceof ApiError && err.code === "safety_ack_required") throw err;
				setError(errText(err));
			} finally {
				setBusy(false);
			}
		});

	return (
		<div className="tg-actions">
			{canConnect && !status && (
				<button
					type="button"
					className="primary"
					disabled={busy}
					onClick={() => void connect().catch(() => undefined)}
					aria-label={`Connect with ${name}`}
				>
					Connect
				</button>
			)}
			<button type="button" onClick={() => setOpen("block")} aria-label={`Block ${name}`}>
				Block
			</button>
			<button type="button" onClick={() => setOpen("report")} aria-label={`Report ${name}`}>
				Report
			</button>
			{status && (
				<span className="tg-status" role="status">
					{status}
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
			{gate.dialog}
		</div>
	);
}
