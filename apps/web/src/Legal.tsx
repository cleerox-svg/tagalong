/**
 * The public pages both app stores require (spec §9 phase 8): privacy, terms,
 * support and account deletion. They render signed out, signed in, and on a
 * cold load without any account request (App.tsx skips /me for these paths).
 *
 * Every factual claim here matches docs/STORE_LISTING.md (the data inventory)
 * and docs/SETUP.md §1h (what deletion removes and keeps). Change them together.
 */
import { useEffect, type ReactNode } from "react";
import { DELETE_CONFIRM_WORD } from "./account.js";
import { linkTo } from "./router.js";

export const SUPPORT_EMAIL = "support@averrow.com";

/** Shown verbatim so the owner fills them in before store submission. */
const CONTROLLER = "{{CONTROLLER}}";
const EFFECTIVE_DATE = "{{EFFECTIVE_DATE}}";

export const LEGAL_PAGES = {
	"/privacy": "Privacy Policy",
	"/terms": "Terms of Use",
	"/support": "Support",
	"/delete-account": "Delete your account",
} as const;
export type LegalPath = keyof typeof LEGAL_PAGES;

export function isLegalPath(path: string): path is LegalPath {
	return Object.hasOwn(LEGAL_PAGES, path);
}

/** The page for a legal path, or null. */
export function legalPage(path: string): ReactNode {
	if (!isLegalPath(path)) return null;
	switch (path) {
		case "/privacy":
			return <Privacy />;
		case "/terms":
			return <Terms />;
		case "/support":
			return <Support />;
		case "/delete-account":
			return <DeleteAccountInfo />;
	}
}

/** An in-app link that keeps normal browser behaviour for modified clicks. */
export function PageLink({ to, children }: { to: string; children: ReactNode }) {
	return (
		<a href={to} onClick={linkTo(to)}>
			{children}
		</a>
	);
}

function Mail() {
	return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
}

/** A placeholder the owner must replace; visibly marked, never mistaken for real text. */
function Fill({ children }: { children: string }) {
	return <mark className="legal-fill">{children}</mark>;
}

function LegalShell({ path, children }: { path: LegalPath; children: ReactNode }) {
	const title = LEGAL_PAGES[path];
	useEffect(() => {
		const before = document.title;
		document.title = `${title} · Budgetrip`;
		return () => {
			document.title = before;
		};
	}, [title]);
	return (
		<article className="card legal" aria-labelledby="legal-h">
			<h1 id="legal-h">{title}</h1>
			{children}
		</article>
	);
}

/** Privacy, Terms and Support: on every screen, 44px tap targets. */
export function LegalLinks() {
	return (
		<nav aria-label="Legal and support" className="legal-links">
			<PageLink to="/privacy">Privacy</PageLink>
			<PageLink to="/terms">Terms</PageLink>
			<PageLink to="/support">Support</PageLink>
		</nav>
	);
}

/** "By continuing you agree…", under sign-in and onboarding. */
export function AgreeNote() {
	return (
		<p className="note agree-note">
			By continuing you agree to the <PageLink to="/terms">Terms of Use</PageLink> and{" "}
			<PageLink to="/privacy">Privacy Policy</PageLink>.
		</p>
	);
}

function Privacy() {
	return (
		<LegalShell path="/privacy">
			<p className="muted">
				Effective <Fill>{EFFECTIVE_DATE}</Fill>
			</p>
			<p>
				Budgetrip plans trips to events within a budget. Tagalong is its optional social layer. This
				policy covers both, in the app and at tagalong.averrow.com.
			</p>

			<h2>Who we are</h2>
			<p>
				Budgetrip and Tagalong are run by <Fill>{CONTROLLER}</Fill>, which is responsible for your
				data. Questions about privacy: <Mail />.
			</p>

			<h2>The short version</h2>
			<ul>
				<li>
					No ads, no tracking and no analytics. There is no advertising, analytics or
					crash-reporting tool in the app.
				</li>
				<li>We don't sell or rent your data, and we don't use it for advertising.</li>
				<li>
					We collect what the app needs to work, send each service only what it needs, and you can
					delete your account and its data at any time.
				</li>
				<li>We never read your device's location. The app asks for no location permission.</li>
			</ul>

			<h2>What we collect and why</h2>
			<h3>Your account</h3>
			<ul>
				<li>
					<strong>Email address, name and account id</strong> from Google or Apple when you sign in,
					to identify your account. Your email is also where price-drop emails go. If you use
					Apple's "Hide My Email", we store the relay address Apple gives us, and only if Apple
					marks it verified.
				</li>
				<li>
					<strong>That you confirmed you are 18 or older.</strong> We don't ask for your birthdate.
				</li>
				<li>
					<strong>Your currency for budgets</strong>, and a <strong>home city</strong> if you give
					one, used as the default for your Tagalong city.
				</li>
				<li>
					<strong>A sign-in session</strong>: a signed cookie in the browser, or a signed token in
					your device's secure storage in the app. It lasts up to 30 days.
				</li>
			</ul>

			<h3>Your trips</h3>
			<ul>
				<li>
					<strong>What you type to describe a trip</strong> (up to 2,000 characters), if you use
					"Fill in the form for me". We use it to fill in the form, which you check before anything
					is planned. If you then plan the trip, it is saved with the trip.
				</li>
				<li>
					<strong>The trip details you confirm</strong>: starting city (with the city centre's
					coordinates), event, event city, dates, number of people, budget and preferences,
					including any accessibility notes you add (optional, up to 500 characters) and any event
					link you paste.
				</li>
				<li>
					<strong>Your plans, saved trips, share links and price-drop alerts</strong>, so you can
					come back to them and so we can check saved trips for lower prices.
				</li>
			</ul>

			<h3>Approximate location</h3>
			<p>
				The only location we hold is a city you choose or type: your trip's starting city (and the
				centre of that city), your Tagalong city, and your home city if you give one. Nothing more
				precise than a city about you is ever shown to anyone else.
			</p>

			<h3>Tagalong (only if you join)</h3>
			<ul>
				<li>
					<strong>Your Tagalong name and city</strong>: the only things about you other members see,
					besides what you choose to write. Never your email, your Google or Apple name, or your
					exact location.
				</li>
				<li>
					Your group memberships and interest line, connections, messages (group and direct), the
					people you block, and reports you make.
				</li>
			</ul>

			<h3>Notifications (app only)</h3>
			<p>
				If you allow notifications, we store your device's push token and platform, and your
				notification settings. A notification carries a Tagalong name, an event name or a price —
				never message text, a location or an email address.
			</p>

			<h3>Security</h3>
			<p>
				To stop abuse, we count requests by IP address on sign-in, on the app's sign-in hand-off and
				on public share links. These IP records are kept for at most 24 hours and aren't linked to
				your account. Our host, Cloudflare, also records each request to our servers (including its
				address and IP) in its logs, which we use to fix errors. Those logs are kept for the period
				Cloudflare's logging service keeps them.
			</p>

			<h2>Who handles your data for us</h2>
			<p>
				These services process data on our behalf, each receiving only what it needs. None of the
				travel or search services receives your name, email or account id.
			</p>
			<ul>
				<li>
					<strong>Cloudflare</strong>: hosting, our database and request logs.
				</li>
				<li>
					<strong>Google</strong> and <strong>Apple</strong>: sign-in. When you delete your account,
					we ask Apple to revoke Sign in with Apple.
				</li>
				<li>
					<strong>Anthropic</strong> (Claude): only the trip description you type, with today's
					date, when you tap "Fill in the form for me". Filling in the form yourself sends nothing
					to Anthropic.
				</li>
				<li>
					<strong>Google Places</strong>: the city name you search for.
				</li>
				<li>
					<strong>Ticketmaster</strong>: event searches (keyword, city, dates; or an area around a
					city's centre when you browse).
				</li>
				<li>
					<strong>Eventbrite</strong>: the event id from an Eventbrite link you paste.
				</li>
				<li>
					<strong>Duffel</strong>: flight searches (approximate start and venue locations, airports,
					dates, number of adults).
				</li>
				<li>
					<strong>Booking.com</strong>: hotel searches (the venue's area, dates, guests, rooms,
					currency and your starting country).
				</li>
				<li>
					<strong>Resend</strong>: price-drop emails (your email address, the event, the old and new
					price and a link to your plan).
				</li>
				<li>
					<strong>Firebase Cloud Messaging</strong> (Google) and{" "}
					<strong>Apple Push Notification service</strong>: delivering notifications to your device.
				</li>
				<li>
					<strong>Frankfurter</strong>: currency codes only, for exchange rates.
				</li>
			</ul>
			<p>
				If you paste a link to another event page, our server reads that page; the site sees a
				request from our server, not from your device.
			</p>

			<h2>Who else can see what</h2>
			<ul>
				<li>
					Tagalong members in your groups and connections see your Tagalong name, city, interest
					line and messages.
				</li>
				<li>
					Anyone with a share link you create sees that plan, its starting city and budget, but not
					your trip description or accessibility notes. You can turn a link off with Stop sharing.
				</li>
				<li>
					Our moderators see reports and the reported content, with Tagalong names and cities —
					never an email address or home location.
				</li>
			</ul>

			<h2>How long we keep it</h2>
			<p>Your data stays until you delete it or delete your account, except for the following:</p>
			<ul>
				<li>IP records for abuse prevention: at most 24 hours.</li>
				<li>App sign-in codes: 60 seconds, single use.</li>
				<li>
					Search results are cached briefly (city searches up to 7 days, flight and airport data up
					to 30 days), keyed by the search, not by you.
				</li>
				<li>
					Leaving Tagalong keeps your Tagalong name and city (no longer shown to anyone) until you
					delete your account. Deleting one of your messages hides it but keeps its text, for
					moderation, until you delete your account.
				</li>
				<li>
					Some things are kept after you delete your account. See{" "}
					<PageLink to="/delete-account">Delete your account</PageLink> for the full list.
				</li>
			</ul>

			<h2>Your choices</h2>
			<ul>
				<li>
					Delete your account and its data at any time, in the app or on the web:{" "}
					<PageLink to="/delete-account">how to delete your account</PageLink>.
				</li>
				<li>Turn price-drop alerts off for any saved trip under My trips.</li>
				<li>Turn each kind of notification on or off under Notifications.</li>
				<li>Leave Tagalong at any time; you stop appearing to anyone.</li>
				<li>
					To ask what data we hold about you, or to have it corrected or deleted, email <Mail />.
				</li>
			</ul>

			<h2>Adults only</h2>
			<p>
				Budgetrip and Tagalong are for people 18 or older. We don't knowingly collect data from
				anyone younger.
			</p>

			<h2>Security</h2>
			<p>
				All data travels over HTTPS. Your session is kept in a cookie scripts can't read, or in your
				device's secure storage in the app.
			</p>

			<h2>Changes</h2>
			<p>
				If we change this policy, we'll update it here and change the effective date at the top.
			</p>

			<h2>Contact</h2>
			<p>
				<Fill>{CONTROLLER}</Fill> · <Mail />
			</p>
		</LegalShell>
	);
}

function Terms() {
	return (
		<LegalShell path="/terms">
			<p className="muted">
				Effective <Fill>{EFFECTIVE_DATE}</Fill>
			</p>
			<p>
				These terms are an agreement between you and <Fill>{CONTROLLER}</Fill> ("we") for using
				Budgetrip and Tagalong, in the app and at tagalong.averrow.com. By using them you agree to
				these terms and to our <PageLink to="/privacy">Privacy Policy</PageLink>.
			</p>

			<h2>Who can use it</h2>
			<p>You must be 18 or older. You confirm this when you sign up.</p>

			<h2>Budgetrip links out; it doesn't sell</h2>
			<p>
				Budgetrip helps you plan. It does not sell tickets, flights, hotels or anything else, takes
				no payment and has no in-app purchases. Each item links to the seller's own website, where
				you book. Any booking is between you and that seller, under their terms and prices.
			</p>

			<h2>Prices</h2>
			<ul>
				<li>
					Prices come from the providers (such as Ticketmaster, Duffel and Booking.com), and each
					shows when it was fetched ("as of"). Prices and availability can change at any time; the
					seller's price when you book is the one that counts.
				</li>
				<li>
					Where there's no live price, we show an estimate, labelled "estimate", with how it was
					worked out. An estimate is a rule of thumb, not a quote.
				</li>
				<li>
					Which packages fit your budget, and their order, is worked out by fixed rules in our code.
				</li>
			</ul>

			<h2>How we use AI</h2>
			<p>
				If you tap "Fill in the form for me", an AI model (Claude, by Anthropic) reads what you
				typed and fills in the trip form. You check and correct every field before anything is
				planned. The AI never finds, sets or estimates a price, and it doesn't choose or rank your
				packages. It can misread a request, which is why you confirm the form first.
			</p>

			<h2>Your account</h2>
			<p>
				You sign in with Google or Apple. Keep that account secure; you're responsible for what's
				done with your Budgetrip account. You can{" "}
				<PageLink to="/delete-account">delete your account</PageLink> at any time.
			</p>

			<h2>Tagalong: community rules</h2>
			<p>
				Tagalong is optional, opt-in and for adults only. When you join, you agree to these rules.{" "}
				<strong>We have zero tolerance for objectionable content and abusive users.</strong> Don't
				post or send:
			</p>
			<ul>
				<li>harassment, bullying, threats or hate;</li>
				<li>sexual, violent or otherwise objectionable content;</li>
				<li>spam, scams or advertising;</li>
				<li>anyone's private information, such as an address, phone number or email;</li>
				<li>anything illegal, or anything pretending to be someone else.</li>
			</ul>
			<p>
				Every message and profile has <strong>Report</strong> and <strong>Block</strong>. Blocking
				hides you and that person from each other. Reports go to our moderators, who review them and
				can remove content and suspend accounts from Tagalong. A suspension stays in place if you
				delete your account and sign up again with the same Google or Apple account.
			</p>
			<p>
				We don't check who people are. If you meet anyone in person, meet in a public place, and
				take the same care you would with anyone you've met online.
			</p>

			<h2>Your content</h2>
			<p>
				You're responsible for what you write. You let us store it and show it to the people you
				share it with (your groups, your connections, or anyone with a share link you create), only
				to run the service.
			</p>

			<h2>Fair use</h2>
			<p>
				Don't misuse the service: no scraping, automated sign-ups, getting around limits or
				suspensions, or interfering with how it works. We may limit or suspend access to protect
				other people or the service.
			</p>

			<h2>Disclaimers</h2>
			<p>
				Budgetrip is provided "as is". Event, travel and price information comes from third parties,
				and we can't guarantee it is complete, accurate or available. We aren't responsible for
				sellers' products, services, prices or policies, or for how other users behave. To the
				extent the law allows, we aren't liable for indirect or consequential losses arising from
				using Budgetrip or Tagalong. Nothing here limits rights you have under the law that can't be
				limited.
			</p>

			<h2>Changes</h2>
			<p>
				We may update these terms. We'll change the effective date at the top; if you keep using
				Budgetrip after that, the new terms apply.
			</p>

			<h2>Contact</h2>
			<p>
				<Fill>{CONTROLLER}</Fill> · <Mail />
			</p>
		</LegalShell>
	);
}

function Support() {
	return (
		<LegalShell path="/support">
			<p>
				Email <Mail /> and tell us what happened, on which device, and the email address you sign in
				with. We never ask for a password.
			</p>

			<h2>Report a user or content</h2>
			<ol>
				<li>
					In Tagalong, tap <strong>Report</strong> on the message or the person's profile.
				</li>
				<li>Pick a reason, add details if you like, and send it.</li>
				<li>
					To stop someone contacting you, tap <strong>Block</strong>. You'll stop seeing each other.
				</li>
			</ol>
			<p>
				Reports go to our moderators, who can remove messages and suspend accounts. You can also
				email <Mail /> with the person's Tagalong name, the event group and what happened. If anyone
				is in danger, contact your local emergency services first.
			</p>

			<h2>Common questions</h2>
			<h3>Can I buy tickets or book through Budgetrip?</h3>
			<p>
				No. Budgetrip doesn't sell anything or take payment. Each item links to the seller, where
				you book.
			</p>
			<h3>Why is the price different on the seller's site?</h3>
			<p>
				Prices come from the providers and show when they were fetched; they can change after that.
				Tap <strong>Re-check prices</strong> on a plan for fresh ones. The seller's price is final.
			</p>
			<h3>What does "estimate" mean?</h3>
			<p>
				There was no live price for that item, so we show a rule-of-thumb figure and say how we
				worked it out. Check the real price before you book.
			</p>
			<h3>Does the AI set prices?</h3>
			<p>
				No. The AI only reads your trip description into the form, which you check. Prices come from
				providers.
			</p>
			<h3>How do I stop price-drop emails or notifications?</h3>
			<p>
				Untick <strong>Price-drop alerts</strong> for the trip under My trips, or turn kinds of
				notification off under Notifications.
			</p>
			<h3>Who can see me on Tagalong?</h3>
			<p>
				Only the name and city you chose, plus what you write — never your email or exact location.
				To leave, go to Tagalong and tap <strong>Leave Tagalong</strong>.
			</p>
			<h3>How do I delete my account?</h3>
			<p>
				See <PageLink to="/delete-account">Delete your account</PageLink>.
			</p>

			<h2>More</h2>
			<p>
				<PageLink to="/privacy">Privacy Policy</PageLink> ·{" "}
				<PageLink to="/terms">Terms of Use</PageLink>
			</p>
		</LegalShell>
	);
}

function DeleteAccountInfo() {
	return (
		<LegalShell path="/delete-account">
			<p>
				You can delete your Budgetrip account, and the data under it, yourself at any time. It takes
				effect straight away, signs you out on every device, and can't be undone.
			</p>

			<h2>In the app or on the web</h2>
			<ol>
				<li>
					Sign in (in the app, or at <PageLink to="/">tagalong.averrow.com</PageLink>).
				</li>
				<li>
					Open <strong>Account</strong> in the top menu.
				</li>
				<li>
					Under <strong>Delete account</strong>, type <strong>{DELETE_CONFIRM_WORD}</strong> in
					capital letters.
				</li>
				<li>
					Tap <strong>Delete my account</strong>.
				</li>
				<li>
					In "Delete your account for good?", tap <strong>Delete account</strong>.
				</li>
			</ol>

			<h2>By email</h2>
			<p>
				If you can't sign in, email <Mail /> from the address on your account and ask us to delete
				it. We may ask you to confirm the request.
			</p>

			<h2>What is deleted</h2>
			<ul>
				<li>Your email, names, home city and Tagalong profile</li>
				<li>Your trips, plans, saved trips, share links (they stop working) and price alerts</li>
				<li>Your registered devices, notification settings and pending sign-in codes</li>
				<li>Your Tagalong group memberships and blocks</li>
				<li>Your messages: hidden from chat and their text replaced with "[message deleted]"</li>
				<li>Your Sign in with Apple grant, which we ask Apple to revoke</li>
			</ul>

			<h2>What is kept, and for how long</h2>
			<ul>
				<li>
					An empty account record shown as "Deleted user", with its id and dates, so reports and
					chat history still make sense. Kept indefinitely.
				</li>
				<li>Reports you made and reports about you. Kept indefinitely.</li>
				<li>
					The text of any of your messages that someone reported, hidden from chat and kept for
					moderation. Kept indefinitely.
				</li>
				<li>Your connections, closed, with who asked and when. Kept indefinitely.</li>
				<li>
					If your Tagalong access was suspended: that suspension, and a one-way coded fingerprint of
					each Google or Apple account you signed in with (no email, name or account id), so a new
					account from the same sign-in starts suspended from Tagalong. Kept indefinitely. Nothing
					like this is kept for accounts that weren't suspended.
				</li>
				<li>
					Events you described yourself (an event name, city and date) are stored for everyone, not
					under your account, and aren't removed.
				</li>
				<li>
					IP records for abuse prevention expire within 24 hours, and our host's request logs follow
					its own retention period.
				</li>
			</ul>
			<p>
				If you sign in again with the same Google or Apple account later, you start with a new,
				empty account.
			</p>
		</LegalShell>
	);
}
