import {
	DEFAULT_NOTIFICATION_PREFS,
	NOTIFICATION_KINDS,
	type NotificationKind,
	type NotificationPrefs,
} from "@tagalong/shared";
import { useEffect, useId, useState } from "react";
import { api } from "./api.js";
import { enablePush, isNative, pushPermission, type PushPermission } from "./native.js";

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
		description: "When a saved trip with price alerts on gets cheaper.",
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

/** Settings → Notifications: one toggle per kind, each saved as it changes. */
export function Notifications() {
	const ids = useId();
	const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saving, setSaving] = useState<ReadonlySet<NotificationKind>>(new Set());
	const native = isNative();

	useEffect(() => {
		let live = true;
		api
			.notificationPrefs()
			.then((p) => live && setPrefs(normalizePrefs(p)))
			.catch(() => live && setLoadError("We couldn't load your notification settings. Try again."));
		return () => {
			live = false;
		};
	}, []);

	const toggle = async (kind: NotificationKind, value: boolean) => {
		setSaveError(null);
		setPrefs((p) => (p ? { ...p, [kind]: value } : p));
		setSaving((s) => new Set(s).add(kind));
		try {
			const updated = normalizePrefs(await api.setNotificationPrefs({ [kind]: value }));
			// Keep this kind as the server has it; leave other in-flight toggles alone.
			setPrefs((p) => (p ? { ...p, [kind]: updated[kind] } : updated));
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

	return (
		<section className="card narrow" aria-labelledby={`${ids}-h`}>
			<h1 id={`${ids}-h`}>Notifications</h1>
			{native ? (
				<PushStatus />
			) : (
				<p className="note">
					Push notifications are available in the Budgetrip app. What you choose here applies
					there.
				</p>
			)}
			{loadError && (
				<p className="error" role="alert">
					{loadError}
				</p>
			)}
			{!prefs && !loadError && <p className="muted">Loading…</p>}
			{prefs && (
				<fieldset className="notif-prefs">
					<legend>Notify me about</legend>
					<ul className="notif-list">
						{NOTIFICATION_KINDS.map((kind) => (
							<li key={kind}>
								<label className="check notif-toggle">
									<input
										type="checkbox"
										role="switch"
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
				</fieldset>
			)}
			<p className="error notif-error" role="alert">
				{saveError}
			</p>
		</section>
	);
}

/** In the app: whether this phone will show notifications, and a way to allow them. */
function PushStatus() {
	const [perm, setPerm] = useState<PushPermission | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let live = true;
		void pushPermission().then((p) => live && setPerm(p));
		return () => {
			live = false;
		};
	}, []);

	if (perm === null || perm === "granted") return null;
	if (perm === "unsupported")
		return <p className="note">Push notifications aren't available on this device.</p>;
	if (perm === "denied")
		return (
			<p className="note">
				Notifications are turned off for Budgetrip on this phone. To get them, allow them for
				Budgetrip in your phone's Settings.
			</p>
		);
	return (
		<div className="notif-enable">
			<p className="note">This phone isn't set up to show Budgetrip notifications yet.</p>
			<button
				type="button"
				className="primary"
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					setPerm(await enablePush());
					setBusy(false);
				}}
			>
				Enable push notifications
			</button>
		</div>
	);
}
