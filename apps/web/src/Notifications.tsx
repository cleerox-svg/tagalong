import {
	DEFAULT_NOTIFICATION_PREFS,
	NOTIFICATION_KINDS,
	type NotificationKind,
	type NotificationPrefs,
} from "@tagalong/shared";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "./api.js";
import { ErrorCard } from "./ErrorCard.js";
import { enablePush, isNative, pushPermission, type PushOutcome } from "./native.js";
import { useMe } from "./TagalongGate.js";

const KIND_TEXT: Record<NotificationKind, { label: string; description: string }> = {
	dm: {
		label: "Direct messages",
		description: "When one of your connections sends you a message.",
	},
	group_message: {
		label: "Group chat messages",
		description: "New messages in event groups you've joined. Off to start: groups can be busy.",
	},
	connection_request: {
		label: "Connection requests",
		description: "When someone asks to connect with you.",
	},
	connection_accepted: {
		label: "Accepted requests",
		description: "When someone accepts your connection request.",
	},
	price_drop: {
		label: "Price drops",
		description:
			"A push when a saved trip gets cheaper. Price-drop emails are set per trip in My trips.",
	},
};

/** Every kind present and boolean; anything missing falls back to its default. */
export function normalizePrefs(raw: unknown): NotificationPrefs {
	const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const out = { ...DEFAULT_NOTIFICATION_PREFS };
	for (const k of NOTIFICATION_KINDS) {
		const v = src[k];
		if (typeof v === "boolean") out[k] = v;
	}
	return out;
}

/** Kinds that only make sense once you've joined Tagalong (chat and connections). */
const TAGALONG_KINDS: ReadonlySet<NotificationKind> = new Set([
	"dm",
	"group_message",
	"connection_request",
	"connection_accepted",
]);

/** The kinds to show: everything with Tagalong on, otherwise just price drops. */
export function visibleKinds(tagalongOn: boolean): NotificationKind[] {
	return NOTIFICATION_KINDS.filter((k) => tagalongOn || !TAGALONG_KINDS.has(k));
}

const SAVED_MS = 2500;

/** Settings → Notifications: one toggle per kind, each saved as it changes. */
export function Notifications() {
	const ids = useId();
	const ctx = useMe();
	const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState("");
	const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [saving, setSaving] = useState<ReadonlySet<NotificationKind>>(new Set());
	const native = isNative();
	const heading = useRef<HTMLHeadingElement>(null);
	const retried = useRef(false);
	const tagalong = ctx?.me.tagalong;
	const tagalongOn = Boolean(tagalong?.opted_in && !tagalong.suspended);

	useEffect(() => {
		let live = true;
		setLoadError(null);
		api
			.notificationPrefs()
			.then((p) => live && setPrefs(normalizePrefs(p)))
			.catch(() => live && setLoadError("We couldn't load your notification settings."));
		return () => {
			live = false;
		};
	}, [attempt]);

	useEffect(() => () => clearTimeout(savedTimer.current), []);

	// After "Try again" the button is gone: put focus on the page heading.
	useEffect(() => {
		if (retried.current && !loadError && heading.current) {
			retried.current = false;
			heading.current.focus();
		}
	}, [loadError]);

	const toggle = async (kind: NotificationKind, value: boolean) => {
		setSaveError(null);
		setSaved("");
		clearTimeout(savedTimer.current);
		setPrefs((p) => (p ? { ...p, [kind]: value } : p));
		setSaving((s) => new Set(s).add(kind));
		try {
			const updated = normalizePrefs(await api.setNotificationPrefs({ [kind]: value }));
			// Keep this kind as the server has it; leave other in-flight toggles alone.
			setPrefs((p) => (p ? { ...p, [kind]: updated[kind] } : updated));
			setSaved("Saved.");
			savedTimer.current = setTimeout(() => setSaved(""), SAVED_MS);
		} catch {
			setPrefs((p) => (p ? { ...p, [kind]: !value } : p));
			setSaveError(
				`We couldn't save "${KIND_TEXT[kind].label}". It's back how it was. Check your connection and try again.`,
			);
		} finally {
			setSaving((s) => {
				const next = new Set(s);
				next.delete(kind);
				return next;
			});
		}
	};

	if (loadError)
		return (
			<ErrorCard message={loadError} to="/trips" label="My trips">
				<p>
					<button
						type="button"
						onClick={() => {
							retried.current = true;
							setAttempt((n) => n + 1);
						}}
					>
						Try again
					</button>
				</p>
			</ErrorCard>
		);

	return (
		<section className="card narrow" aria-labelledby={`${ids}-h`}>
			<h1 id={`${ids}-h`} ref={heading} tabIndex={-1}>
				Notifications
			</h1>
			{native ? (
				<PushStatus />
			) : (
				<p className="note">
					Push notifications are available in the Budgetrip app. What you choose here applies there.
				</p>
			)}
			{!prefs && <p className="muted">Loading…</p>}
			{prefs && (
				<fieldset className="notif-prefs">
					<legend>Push notifications in the app</legend>
					<ul className="notif-list">
						{visibleKinds(tagalongOn).map((kind) => (
							<li key={kind}>
								<label className="check notif-toggle">
									<input
										type="checkbox"
										checked={prefs[kind]}
										aria-describedby={`${ids}-${kind}-d`}
										// Not `disabled`: that would drop keyboard focus mid-save.
										aria-disabled={saving.has(kind) || undefined}
										onChange={(e) => {
											if (!saving.has(kind)) void toggle(kind, e.target.checked);
										}}
									/>
									<span>{KIND_TEXT[kind].label}</span>
								</label>
								<p id={`${ids}-${kind}-d`} className="note notif-desc">
									{KIND_TEXT[kind].description}
								</p>
							</li>
						))}
					</ul>
					{!tagalongOn && (
						<p className="note">
							Notifications for messages and connections appear here once you join Tagalong.
						</p>
					)}
				</fieldset>
			)}
			{/* Both always mounted, so what they say is announced when it appears. */}
			<p className="note notif-error" role="status">
				{saved}
			</p>
			<p className="error notif-error" role="alert">
				{saveError}
			</p>
		</section>
	);
}

const PUSH_ON = "Notifications are on for this phone.";
const PUSH_DENIED =
	"Notifications are turned off for Budgetrip on this phone. To get them, allow them for Budgetrip in your phone's Settings.";
const PUSH_FAILED =
	"We couldn't turn on notifications for this phone. Check your connection and try again.";

/** In the app: whether this phone will show notifications, and a way to allow them. */
function PushStatus() {
	const [perm, setPerm] = useState<PushOutcome | null>(null);
	const [busy, setBusy] = useState(false);
	/** What the last tap on "Enable" came to, for the live region. */
	const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null);
	const stateText = useRef<HTMLParagraphElement>(null);
	const moveFocus = useRef(false);

	useEffect(() => {
		let live = true;
		void pushPermission().then((p) => live && setPerm(p));
		return () => {
			live = false;
		};
	}, []);

	// The button goes away once it worked (or was refused): keep focus on the page.
	useEffect(() => {
		if (moveFocus.current && perm !== "prompt" && perm !== "failed") {
			moveFocus.current = false;
			stateText.current?.focus();
		}
	}, [perm]);

	const enable = async (button: HTMLButtonElement) => {
		if (busy) return;
		setBusy(true);
		setOutcome(null);
		const result = await enablePush();
		setBusy(false);
		if (result === "failed") {
			// The button stays so they can try again.
			setOutcome({ text: PUSH_FAILED, failed: true });
			return;
		}
		moveFocus.current = document.activeElement === button;
		setPerm(result);
		setOutcome({
			text: result === "granted" ? PUSH_ON : result === "denied" ? PUSH_DENIED : "",
			failed: false,
		});
	};

	let body: ReactNode = null;
	if (perm === "granted")
		body = (
			<p className="note" ref={stateText} tabIndex={-1}>
				{PUSH_ON}
			</p>
		);
	else if (perm === "unsupported")
		body = (
			<p className="note" ref={stateText} tabIndex={-1}>
				Push notifications aren't available on this device.
			</p>
		);
	else if (perm === "denied")
		body = (
			<p className="note" ref={stateText} tabIndex={-1}>
				{PUSH_DENIED}
			</p>
		);
	else if (perm !== null)
		body = (
			<>
				<p className="note">This phone isn't set up to show Budgetrip notifications yet.</p>
				<button
					type="button"
					className="primary"
					aria-disabled={busy || undefined}
					onClick={(e) => void enable(e.currentTarget)}
				>
					{busy ? "Turning on…" : "Enable push notifications"}
				</button>
			</>
		);

	return (
		<div className="notif-enable">
			{body}
			{/* Always mounted, so the outcome is announced. A failure stays visible;
			    success is already shown above, so it's only spoken. */}
			<p className={outcome?.failed ? "error notif-error" : "sr-only"} role="status">
				{outcome?.text}
			</p>
		</div>
	);
}
