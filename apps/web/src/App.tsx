import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Me } from "./api.js";
import { Connections, Profile } from "./Connections.js";
import { Dm } from "./Dm.js";
import { Group } from "./Group.js";
import { Moderation } from "./Moderation.js";
import {
	attachPushListeners,
	isNative,
	NativeSignInError,
	nativeSignIn,
	nativeSignOut,
	syncPush,
} from "./native.js";
import { Notifications } from "./Notifications.js";
import { Onboarding } from "./Onboarding.js";
import { Planner } from "./Planner.js";
import { PlanView } from "./PlanView.js";
import { linkTo, usePath } from "./router.js";
import { MeContext, RequireTagalong } from "./TagalongGate.js";
import { Trips } from "./Trips.js";

/** Tagalong ids are opaque server ids (UUIDs today). */
const TG_ID = "([A-Za-z0-9_-]{1,64})";
const groupRe = new RegExp(`^/groups/${TG_ID}$`);
const dmRe = new RegExp(`^/dm/${TG_ID}$`);
const personRe = new RegExp(`^/people/${TG_ID}$`);

type Session =
	| { state: "loading" }
	| { state: "signed_out" }
	| { state: "error"; message: string }
	| { state: "in"; me: Me };

export function App() {
	const [session, setSession] = useState<Session>({ state: "loading" });
	const path = usePath();

	const load = useCallback(async () => {
		try {
			setSession({ state: "in", me: await api.me() });
			// In the app: refresh this device's push registration if push is
			// already allowed. Never asks for permission here.
			if (isNative()) void syncPush().catch(() => undefined);
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) setSession({ state: "signed_out" });
			else
				setSession({
					state: "error",
					message: "We can't reach Budgetrip right now. Try again shortly.",
				});
		}
	}, []);

	useEffect(() => {
		// In the app, catch notification taps (including the one that launched it).
		if (isNative()) void attachPushListeners();
		void load();
	}, [load]);

	const me = session.state === "in" ? session.me : null;
	const meCtx = useMemo(() => (me ? { me, reload: load } : null), [me, load]);

	const planMatch = /^\/plans\/([0-9a-f-]{36})$/.exec(path);
	// Public read-only share links work without signing in.
	const sharedMatch = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(path);
	const groupMatch = groupRe.exec(path);
	const dmMatch = dmRe.exec(path);
	const personMatch = personRe.exec(path);

	const tagalongPage = (() => {
		if (path === "/connections")
			return (
				<RequireTagalong>
					<Connections />
				</RequireTagalong>
			);
		if (groupMatch?.[1])
			return (
				<RequireTagalong>
					<Group id={groupMatch[1]} />
				</RequireTagalong>
			);
		if (dmMatch?.[1])
			return (
				<RequireTagalong>
					<Dm connectionId={dmMatch[1]} />
				</RequireTagalong>
			);
		if (personMatch?.[1])
			return (
				<RequireTagalong>
					<Profile userId={personMatch[1]} />
				</RequireTagalong>
			);
		if (path === "/mod") return <Moderation />;
		if (path === "/notifications") return <Notifications />;
		return null;
	})();

	return (
		<MeContext.Provider value={meCtx}>
			<div className="shell">
				<header className="top">
					<a className="brand" href="/" onClick={linkTo("/")}>
						Budgetrip
					</a>
					{session.state === "in" && (
						<div className="who">
							<nav aria-label="Main" className="nav">
								<a
									href="/trips"
									onClick={linkTo("/trips")}
									aria-current={path === "/trips" ? "page" : undefined}
								>
									My trips
								</a>
								<a
									href="/connections"
									onClick={linkTo("/connections")}
									aria-current={path === "/connections" ? "page" : undefined}
								>
									Tagalong
								</a>
								<a
									href="/notifications"
									onClick={linkTo("/notifications")}
									aria-current={path === "/notifications" ? "page" : undefined}
								>
									Notifications
								</a>
								{session.me.is_moderator && (
									<a
										href="/mod"
										onClick={linkTo("/mod")}
										aria-current={path === "/mod" ? "page" : undefined}
									>
										Moderation
									</a>
								)}
							</nav>
							<span className="who-name">{session.me.display_name}</span>
							<button
								type="button"
								className="link"
								onClick={async () => {
									if (isNative()) await nativeSignOut();
									else await api.logout().catch(() => undefined);
									setSession({ state: "signed_out" });
								}}
							>
								Sign out
							</button>
						</div>
					)}
				</header>

				<main>
					{sharedMatch?.[1] && <PlanView token={sharedMatch[1]} />}
					{!sharedMatch && session.state === "loading" && <p className="muted">Loading…</p>}
					{!sharedMatch && session.state === "error" && <p className="error">{session.message}</p>}
					{!sharedMatch && session.state === "signed_out" && (
						<section className="card hero">
							<h1>Event trips that fit your budget</h1>
							<p>
								Tell us where you're starting from, the event, your budget and what you like. We'll
								find the event and build up to five trip packages — tickets, travel, a place to stay
								and things to do — that come in under budget, including the costs people forget.
							</p>
							<SignIn onSignedIn={load} />
						</section>
					)}
					{!sharedMatch && session.state === "in" && !session.me.birthdate_verified_18 && (
						<Onboarding me={session.me} onDone={load} />
					)}
					{!sharedMatch &&
						session.state === "in" &&
						session.me.birthdate_verified_18 &&
						(planMatch?.[1] ? (
							<PlanView id={planMatch[1]} />
						) : tagalongPage ? (
							tagalongPage
						) : path === "/trips" ? (
							<Trips />
						) : (
							<Planner me={session.me} />
						))}
				</main>

				<footer className="foot muted">
					Budgetrip links out to the real sellers and never takes payment. Numbers marked{" "}
					<em>estimate</em> are rules of thumb, not quotes — check the price when you book.
				</footer>
			</div>
		</MeContext.Provider>
	);
}

/** The browser goes to Google and back; the app signs in through the system browser. */
function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Tapping again restarts sign-in (say the browser was dismissed unnoticed);
	// only the latest attempt reports back.
	const attempt = useRef(0);
	if (!isNative())
		return (
			<a className="button primary" href={api.signInUrl()}>
				Sign in with Google
			</a>
		);
	return (
		<>
			<button
				type="button"
				className="primary"
				aria-busy={busy}
				onClick={async () => {
					const mine = ++attempt.current;
					setBusy(true);
					setError(null);
					try {
						await nativeSignIn();
						if (mine === attempt.current) await onSignedIn();
					} catch (err) {
						if (mine === attempt.current)
							setError(
								err instanceof NativeSignInError
									? err.message
									: "We couldn't sign you in. Try again.",
							);
					} finally {
						if (mine === attempt.current) setBusy(false);
					}
				}}
			>
				{busy ? "Signing in…" : "Sign in with Google"}
			</button>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
		</>
	);
}
