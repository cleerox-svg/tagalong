import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthProvider } from "@tagalong/shared";
import { Account } from "./Account.js";
import { api, ApiError, type Me } from "./api.js";
import { APP_CALLBACK_PATH, AppCallback } from "./AppCallback.js";
import { Connections, Profile } from "./Connections.js";
import { Dm } from "./Dm.js";
import { Group } from "./Group.js";
import { Moderation } from "./Moderation.js";
import {
	attachPushListeners,
	isNative,
	nativeAfterAccountDeleted,
	NativeSignInError,
	nativeSignIn,
	nativeSignOut,
	syncPush,
} from "./native.js";
import { Notifications } from "./Notifications.js";
import { Onboarding } from "./Onboarding.js";
import { Planner } from "./Planner.js";
import { PlanView } from "./PlanView.js";
import { linkTo, navigate, usePath } from "./router.js";
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
	/** A one-off status line, e.g. after deleting the account. */
	const [notice, setNotice] = useState<string | null>(null);
	const path = usePath();

	const load = useCallback(async () => {
		try {
			const me = await api.me();
			setNotice(null);
			setSession({ state: "in", me });
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

	/** The server deleted the account and ended the session: forget it here too. */
	const accountDeleted = useCallback(async () => {
		if (isNative()) await nativeAfterAccountDeleted().catch(() => undefined);
		setSession({ state: "signed_out" });
		navigate("/");
		setNotice("Your account was deleted.");
	}, []);
	const meCtx = useMemo(() => (me ? { me, reload: load } : null), [me, load]);

	const planMatch = /^\/plans\/([0-9a-f-]{36})$/.exec(path);
	// Public read-only share links work without signing in.
	const sharedMatch = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(path);
	// The native sign-in link opened in a browser: always shown, signed in or not.
	const appCallback = path === APP_CALLBACK_PATH;
	const publicPage = sharedMatch?.[1] ? (
		<PlanView token={sharedMatch[1]} />
	) : appCallback ? (
		<AppCallback />
	) : null;
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
								<a
									href="/account"
									onClick={linkTo("/account")}
									aria-current={path === "/account" ? "page" : undefined}
								>
									Account
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
									setNotice(null);
									setSession({ state: "signed_out" });
								}}
							>
								Sign out
							</button>
						</div>
					)}
				</header>

				<main>
					<p role="status" className={notice ? "notice" : "sr-only"}>
						{notice}
					</p>
					{publicPage}
					{!publicPage && session.state === "loading" && <p className="muted">Loading…</p>}
					{!publicPage && session.state === "error" && <p className="error">{session.message}</p>}
					{!publicPage && session.state === "signed_out" && (
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
					{!publicPage && session.state === "in" && path === "/account" && (
						// Before onboarding too: deleting an account never waits on anything.
						<Account me={session.me} onDeleted={accountDeleted} />
					)}
					{!publicPage &&
						session.state === "in" &&
						path !== "/account" &&
						!session.me.birthdate_verified_18 && <Onboarding me={session.me} onDone={load} />}
					{!publicPage &&
						session.state === "in" &&
						path !== "/account" &&
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

/**
 * Sign in with Google or Apple. The browser goes to the provider and back; the
 * app signs in through the system browser.
 */
function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
	const [busy, setBusy] = useState<AuthProvider | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Tapping again restarts sign-in (say the browser was dismissed unnoticed);
	// only the latest attempt reports back.
	const attempt = useRef(0);
	if (!isNative())
		return (
			<div className="signin-buttons">
				<a className="button primary signin-button" href={api.signInUrl()}>
					Sign in with Google
				</a>
				<a className="button apple-signin signin-button" href={api.appleSignInUrl()}>
					<AppleLogo />
					<span>Sign in with Apple</span>
				</a>
			</div>
		);
	const start = async (provider: AuthProvider) => {
		const mine = ++attempt.current;
		setBusy(provider);
		setError(null);
		try {
			await nativeSignIn(provider);
			if (mine === attempt.current) await onSignedIn();
		} catch (err) {
			if (mine === attempt.current)
				setError(
					err instanceof NativeSignInError ? err.message : "We couldn't sign you in. Try again.",
				);
		} finally {
			if (mine === attempt.current) setBusy(null);
		}
	};
	return (
		<>
			<div className="signin-buttons">
				<button
					type="button"
					className="primary signin-button"
					aria-busy={busy === "google"}
					onClick={() => void start("google")}
				>
					{busy === "google" ? "Signing in…" : "Sign in with Google"}
				</button>
				<button
					type="button"
					className="apple-signin signin-button"
					aria-busy={busy === "apple"}
					onClick={() => void start("apple")}
				>
					<AppleLogo />
					<span>{busy === "apple" ? "Signing in…" : "Sign in with Apple"}</span>
				</button>
			</div>
			{error && (
				<p className="error" role="alert">
					{error}
				</p>
			)}
		</>
	);
}

/** Apple's logo for the "Sign in with Apple" button; decorative (the text names the button). */
function AppleLogo() {
	return (
		<svg
			className="apple-logo"
			viewBox="0 0 24 24"
			width="18"
			height="18"
			aria-hidden="true"
			focusable="false"
		>
			<path
				fill="currentColor"
				d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
			/>
		</svg>
	);
}
