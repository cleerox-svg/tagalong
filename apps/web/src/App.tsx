import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api.js";
import { Onboarding } from "./Onboarding.js";
import { Planner } from "./Planner.js";
import { PlanView } from "./PlanView.js";
import { navigate, usePath } from "./router.js";
import { Trips } from "./Trips.js";

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

	const planMatch = /^\/plans\/([0-9a-f-]{36})$/.exec(path);
	// Public read-only share links work without signing in.
	const sharedMatch = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(path);
	const go = (to: string) => (e: React.MouseEvent) => {
		e.preventDefault();
		navigate(to);
	};

	return (
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
						<a href="/trips" onClick={go("/trips")}>
							My trips
						</a>
						<span>{session.me.display_name}</span>
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
	);
}
