import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type Me } from "./api.js";
import { Connections, Profile } from "./Connections.js";
import { Dm } from "./Dm.js";
import { Group } from "./Group.js";
import { Moderation } from "./Moderation.js";
import { Onboarding } from "./Onboarding.js";
import { Planner } from "./Planner.js";
import { PlanView } from "./PlanView.js";
import { navigate, usePath } from "./router.js";
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
	const go = (to: string) => (e: React.MouseEvent) => {
		e.preventDefault();
		navigate(to);
	};

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
		return null;
	})();

	return (
		<MeContext.Provider value={meCtx}>
			<div className="shell">
				<header className="top">
					<a
						className="brand"
						href="/"
						onClick={(e) => {
							e.preventDefault();
							navigate("/");
						}}
					>
						Budgetrip
					</a>
					{session.state === "in" && (
						<div className="who">
							<nav aria-label="Main" className="nav">
								<a
									href="/trips"
									onClick={go("/trips")}
									aria-current={path === "/trips" ? "page" : undefined}
								>
									My trips
								</a>
								<a
									href="/connections"
									onClick={go("/connections")}
									aria-current={path === "/connections" ? "page" : undefined}
								>
									Tagalong
								</a>
								{session.me.is_moderator && (
									<a
										href="/mod"
										onClick={go("/mod")}
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
									await api.logout().catch(() => undefined);
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
							<a className="button primary" href={api.signInUrl()}>
								Sign in with Google
							</a>
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
