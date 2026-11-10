import {
	isCityLabel,
	TAGALONG_CITY_MAX,
	TAGALONG_NAME_MAX,
	TagalongOptInSchema,
} from "@tagalong/shared";
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "./api.js";
import { PageLink } from "./Legal.js";

/** The signed-in, age-confirmed user, and a way to re-read /me after a change. */
export interface MeCtx {
	me: Me;
	reload: () => Promise<void>;
}
export const MeContext = createContext<MeCtx | null>(null);

export function useMe(): MeCtx | null {
	return useContext(MeContext);
}

/**
 * Opt in to Tagalong. Users are already 18+ (confirmed at onboarding); here
 * they pick the only two things anyone else will ever see: a name and a city.
 */
export function TagalongGate({
	onDone,
	onCancel,
	intro,
}: {
	onDone?: () => void;
	/** When set, a Cancel button closes the gate (it's opened from another screen). */
	onCancel?: () => void;
	intro?: ReactNode;
}) {
	const ctx = useMe();
	const me = ctx?.me;
	const [name, setName] = useState("");
	const [city, setCity] = useState(() =>
		me?.home_city && isCityLabel(me.home_city.trim()) ? me.home_city.trim() : "",
	);
	const [confirm, setConfirm] = useState(false);
	const [agree, setAgree] = useState(false);
	const [errors, setErrors] = useState<{ name?: string; city?: string; form?: string }>({});
	const [busy, setBusy] = useState(false);
	const ids = useId();

	if (!ctx || !me) return null;
	if (me.tagalong.suspended) return <Suspended />;

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const parsed = TagalongOptInSchema.safeParse({ confirm, name, city });
		if (!parsed.success || !agree) {
			const next: typeof errors = {};
			if (!agree) next.form = "Tick both boxes to join.";
			for (const issue of parsed.success ? [] : parsed.error.issues) {
				const field = issue.path[0];
				if (field === "name")
					next.name ??= `Use 1–${TAGALONG_NAME_MAX} characters, with no links or e-mail addresses.`;
				else if (field === "city")
					next.city ??= "Just a city name, like “Toronto” — no numbers, street or postcode.";
				else if (field === "confirm") next.form ??= "Tick both boxes to join.";
			}
			setErrors(next);
			return;
		}
		setErrors({});
		setBusy(true);
		try {
			await api.tagalongOptIn(parsed.data);
			await ctx.reload();
			onDone?.();
		} catch (err) {
			setErrors({
				form: err instanceof ApiError ? err.message : "That didn't save. Try again.",
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="card narrow tg-gate" aria-labelledby={`${ids}-h`}>
			<h2 id={`${ids}-h`}>Join Tagalong</h2>
			{intro}
			<p>
				Tagalong lets you meet other people going to the same event: a group chat for each event,
				and private messages once you've both agreed to connect.
			</p>
			<ul className="tg-points">
				<li>
					Other people see <strong>only</strong> the name and city you enter below, plus anything
					you choose to write — never your e-mail, your Google name, your address or your exact
					location.
				</li>
				<li>Tagalong is for adults only. You confirmed you're 18 or older when you signed up.</li>
				<li>You can block or report anyone, and leave Tagalong at any time.</li>
				<li>
					<strong>Zero tolerance</strong> for objectionable content and abusive users. Reports go to
					moderators, who can remove messages and suspend accounts. Read the{" "}
					<PageLink to="/terms">Terms of Use</PageLink>.
				</li>
			</ul>
			<form onSubmit={submit} noValidate>
				<label>
					Name others will see
					<input
						value={name}
						maxLength={TAGALONG_NAME_MAX}
						autoComplete="nickname"
						onChange={(e) => setName(e.target.value)}
						aria-invalid={Boolean(errors.name)}
						aria-describedby={`${ids}-name-hint${errors.name ? ` ${ids}-name-err` : ""}`}
					/>
					<span id={`${ids}-name-hint`} className="note">
						A first name or nickname is fine.
					</span>
					{errors.name && (
						<span id={`${ids}-name-err`} className="field-error">
							{errors.name}
						</span>
					)}
				</label>
				<label>
					Your city
					<input
						value={city}
						maxLength={TAGALONG_CITY_MAX}
						onChange={(e) => setCity(e.target.value)}
						aria-invalid={Boolean(errors.city)}
						aria-describedby={`${ids}-city-hint${errors.city ? ` ${ids}-city-err` : ""}`}
					/>
					<span id={`${ids}-city-hint`} className="note">
						City only. Nothing more precise is ever shown.
					</span>
					{errors.city && (
						<span id={`${ids}-city-err`} className="field-error">
							{errors.city}
						</span>
					)}
				</label>
				<label className="check">
					<input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
					I understand that this name and city will be shown to other Tagalong members.
				</label>
				<label className="check">
					<input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />I
					agree to the Terms of Use, including zero tolerance for objectionable content and abusive
					users.
				</label>
				{errors.form && (
					<p className="error" role="alert">
						{errors.form}
					</p>
				)}
				<div className="tg-actions">
					<button className="primary" disabled={busy}>
						{busy ? "Joining…" : "Join Tagalong"}
					</button>
					{onCancel && (
						<button type="button" onClick={onCancel}>
							Cancel
						</button>
					)}
				</div>
			</form>
		</section>
	);
}

export function Suspended() {
	return (
		<section className="card narrow">
			<h2>Tagalong is paused for your account</h2>
			<p>
				A moderator has suspended your Tagalong access after a report. Your trips and plans still
				work as normal.
			</p>
		</section>
	);
}

/** Render children only for an opted-in, non-suspended user; otherwise the gate. */
export function RequireTagalong({ children }: { children: ReactNode }) {
	const ctx = useMe();
	if (!ctx) return null;
	if (ctx.me.tagalong.suspended) return <Suspended />;
	if (!ctx.me.tagalong.opted_in) return <TagalongGate />;
	return <>{children}</>;
}
