/**
 * The account page (spec §9 phase 7, store readiness): who is signed in, how,
 * and in-app account deletion with a typed confirmation and a final dialog.
 */
import { useId, useRef, useState } from "react";
import {
	DELETE_CONFIRM_WORD,
	deleteErrorMessage,
	isDeleteConfirmed,
	providersLabel,
	signedInAs,
} from "./account.js";
import { api, type Me } from "./api.js";
import { Modal } from "./SafetyActions.js";

export function Account({
	me,
	onDeleted,
	onSignOut,
}: {
	me: Me;
	onDeleted: () => Promise<void>;
	/** Shown here on narrow screens only; the header has it otherwise. */
	onSignOut: () => Promise<void>;
}) {
	const id = useId();
	const [typed, setTyped] = useState("");
	const [hint, setHint] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const confirmed = isDeleteConfirmed(typed);
	const providers = providersLabel(me.sign_in_providers);

	return (
		<>
			<section className="card account">
				<h1>Account</h1>
				<dl className="account-facts">
					<div>
						<dt>Signed in as</dt>
						<dd className="account-email">{signedInAs(me)}</dd>
					</div>
					{providers && (
						<div>
							<dt>Sign-in method</dt>
							<dd>{providers}</dd>
						</div>
					)}
				</dl>
				<button type="button" className="account-signout" onClick={() => void onSignOut()}>
					Sign out
				</button>
			</section>

			<section className="card account-danger" aria-labelledby={`${id}-h`}>
				<h2 id={`${id}-h`}>Delete account</h2>
				<p>
					This permanently deletes your Budgetrip account. It can't be undone, and we can't restore
					it for you.
				</p>
				<h3>What gets deleted</h3>
				<ul>
					<li>Your trips, trip plans and saved trips</li>
					<li>Price alerts and share links (shared links stop working)</li>
					<li>Notification settings and the devices registered for notifications</li>
					<li>Your Tagalong profile, group memberships and connections</li>
					<li>Your messages, in groups and in direct messages</li>
				</ul>
				<h3>What we keep</h3>
				<ul>
					<li>
						Messages someone reported, kept for moderation so the report can still be reviewed
					</li>
					<li>Reports you made or that were made about you</li>
				</ul>

				<form
					className="account-confirm"
					onSubmit={(e) => {
						e.preventDefault();
						if (!confirmed) {
							setHint(true);
							inputRef.current?.focus();
							return;
						}
						setConfirming(true);
					}}
				>
					<label htmlFor={`${id}-confirm`}>
						Type <strong>{DELETE_CONFIRM_WORD}</strong> to confirm
					</label>
					<input
						ref={inputRef}
						id={`${id}-confirm`}
						type="text"
						autoComplete="off"
						autoCapitalize="characters"
						autoCorrect="off"
						spellCheck={false}
						value={typed}
						aria-describedby={`${id}-hint`}
						aria-invalid={hint && !confirmed ? true : undefined}
						onChange={(e) => {
							setTyped(e.target.value);
							if (isDeleteConfirmed(e.target.value)) setHint(false);
						}}
					/>
					<p id={`${id}-hint`} className={hint && !confirmed ? "error" : "muted"}>
						{hint && !confirmed
							? `Type ${DELETE_CONFIRM_WORD} in capital letters first.`
							: `The button turns on once you've typed ${DELETE_CONFIRM_WORD}.`}
					</p>
					<button
						type="submit"
						className="danger"
						aria-disabled={confirmed ? undefined : true}
						aria-describedby={`${id}-hint`}
					>
						Delete my account
					</button>
				</form>
			</section>

			{confirming && <DeleteDialog onClose={() => setConfirming(false)} onDeleted={onDeleted} />}
		</>
	);
}

function DeleteDialog({
	onClose,
	onDeleted,
}: {
	onClose: () => void;
	onDeleted: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Modal
			title="Delete your account for good?"
			onClose={() => {
				if (!busy) onClose();
			}}
		>
			<p>
				Your account and everything under 'What gets deleted' is removed straight away. You'll be
				signed out on every device.
			</p>
			<p className="sr-only" role="status">
				{busy ? "Deleting your account…" : ""}
			</p>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
			<div className="tg-dialog-actions">
				<button
					type="button"
					onClick={() => {
						if (!busy) onClose();
					}}
					aria-disabled={busy || undefined}
					autoFocus
				>
					Keep my account
				</button>
				<button
					type="button"
					className="danger"
					aria-busy={busy}
					aria-disabled={busy || undefined}
					onClick={async () => {
						if (busy) return;
						setBusy(true);
						setError(null);
						try {
							await api.deleteAccount();
						} catch (err) {
							setError(deleteErrorMessage(err));
							setBusy(false);
							return;
						}
						// Gone on the server: leave this page (which unmounts the dialog).
						await onDeleted();
					}}
				>
					{busy ? "Deleting…" : "Delete account"}
				</button>
			</div>
		</Modal>
	);
}
