/**
 * Phase 6 review fixes: connection pushes only on a real transition; fair,
 * capped recipients with the throttle claimed only for selected users and
 * released when every send failed; a lost tg_oauth cookie on a native flow
 * still ends on the app URL; and the native sign-in interstitial.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { b64url } from "../auth/session.js";
import { dispatchPush, MAX_RECIPIENTS, MAX_SENDS } from "../push/dispatch.js";
import {
	call,
	groupWith,
	json,
	mockFetch,
	postJson,
	tagalongUser,
	type TgUser,
} from "./helpers.js";

const mutableEnv = env as unknown as Record<string, string | undefined>;
const APP = "https://tagalong.averrow.com/auth/app-callback";

afterEach(() => {
	vi.restoreAllMocks();
	delete mutableEnv.FCM_SERVICE_ACCOUNT_JSON;
});

let fcmSecret = "";
let fcmEnv: Env;

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const der = new Uint8Array(
		(await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
	);
	let bin = "";
	for (const b of der) bin += String.fromCharCode(b);
	const pem = `-----BEGIN PRIVATE KEY-----\n${(btoa(bin).match(/.{1,64}/g) ?? []).join("\n")}\n-----END PRIVATE KEY-----\n`;
	fcmSecret = JSON.stringify({
		project_id: "tagalong-review-test",
		client_email: "push@tagalong-review-test.iam.gserviceaccount.com",
		private_key: pem,
	});
	fcmEnv = { ...env, FCM_SERVICE_ACCOUNT_JSON: fcmSecret };
});

/** Mocks Google OAuth + FCM; `reply` picks the FCM answer per device token. */
function mockFcm(reply: (token: string) => Response = () => json({ name: "projects/x/m/1" })) {
	const sends: { token: string; title: string; body: string; kind: string }[] = [];
	mockFetch(
		(url) =>
			url.host === "oauth2.googleapis.com"
				? json({ access_token: "ya29.review", expires_in: 3600 })
				: undefined,
		(url, init) => {
			if (url.host !== "fcm.googleapis.com") return undefined;
			const msg = (
				JSON.parse(String(init?.body ?? "{}")) as {
					message: {
						token: string;
						notification: { title: string; body: string };
						data: { kind: string };
					};
				}
			).message;
			sends.push({
				token: msg.token,
				title: msg.notification.title,
				body: msg.notification.body,
				kind: msg.data.kind,
			});
			return reply(msg.token);
		},
	);
	return sends;
}

async function addDevice(userId: string): Promise<string> {
	const t = `tok-${crypto.randomUUID()}`;
	await env.DB.prepare(
		"INSERT INTO push_devices (id, user_id, platform, token) VALUES (?, ?, 'android', ?)",
	)
		.bind(crypto.randomUUID(), userId, t)
		.run();
	return t;
}

/** Pretends the throttle window passed for everyone in this room. */
const expireThrottle = (roomKey: string) =>
	env.DB.prepare("UPDATE push_throttle SET last_sent_at = ? WHERE room_key = ?")
		.bind(new Date(Date.now() - 24 * 3600_000).toISOString(), roomKey)
		.run();

const throttleRows = async (roomKey: string) =>
	(
		await env.DB.prepare("SELECT user_id FROM push_throttle WHERE room_key = ?")
			.bind(roomKey)
			.all<{ user_id: string }>()
	).results.map((r) => r.user_id);

describe("connection pushes only on a real transition", () => {
	it("two identical requests push once, even after the throttle window; same for accept", async () => {
		const a = await tagalongUser({ old: true, ack: true });
		const b = await tagalongUser({ old: true, ack: true });
		await groupWith(a, b);
		const aTok = await addDevice(a.id);
		const bTok = await addDevice(b.id);
		mutableEnv.FCM_SERVICE_ACCOUNT_JSON = fcmSecret;
		const sends = mockFcm();

		const first = await postJson("/connections", { user_id: b.id }, a.cookie);
		expect(first.status).toBe(200);
		const { connection } = await first.json<{ connection: { id: string } }>();
		expect(sends).toEqual([expect.objectContaining({ token: bTok, kind: "connection_request" })]);

		await expireThrottle(`connreq:${connection.id}`);
		const again = await postJson("/connections", { user_id: b.id }, a.cookie);
		expect(again.status).toBe(200);
		expect(sends).toHaveLength(1);

		// b asks back: that accepts, and a hears about it once.
		expect((await postJson("/connections", { user_id: a.id }, b.cookie)).status).toBe(200);
		expect(sends).toHaveLength(2);
		expect(sends[1]).toMatchObject({ token: aTok, kind: "connection_accepted" });

		await expireThrottle(`connacc:${connection.id}`);
		expect((await postJson("/connections", { user_id: a.id }, b.cookie)).status).toBe(200);
		expect((await postJson("/connections", { user_id: b.id }, a.cookie)).status).toBe(200);
		expect(sends).toHaveLength(2);
	});
});

describe("recipient cap and throttle claims", () => {
	it("caps recipients at or below the send cap", () => {
		expect(MAX_SENDS).toBeLessThanOrEqual(49);
		expect(MAX_RECIPIENTS).toBeLessThanOrEqual(MAX_SENDS);
	});

	it(
		"claims the throttle only for selected users; the rest come first next time",
		{ timeout: 120_000 },
		async () => {
			const author = await tagalongUser({ old: true });
			const members: TgUser[] = [];
			for (let i = 0; i < MAX_RECIPIENTS + 1; i++) members.push(await tagalongUser({ old: true }));
			const { groupId } = await groupWith(author, ...members);
			const owner = new Map<string, string>();
			await env.DB.batch(
				members.map((m) =>
					env.DB.prepare(
						"INSERT INTO notification_prefs (user_id, group_message) VALUES (?, 1)",
					).bind(m.id),
				),
			);
			for (const m of members) owner.set(await addDevice(m.id), m.id);
			const room = `group:${groupId}`;

			const sends = mockFcm();
			await dispatchPush(fcmEnv, { kind: "group_message", authorId: author.id, groupId });
			expect(sends).toHaveLength(MAX_RECIPIENTS);
			const firstRound = new Set(sends.map((s) => owner.get(s.token)));
			const claimed = await throttleRows(room);
			// Exactly the users a send went to hold a throttle row; the one left out doesn't.
			expect(new Set(claimed)).toEqual(firstRound);
			const left = members.filter((m) => !firstRound.has(m.id));
			expect(left).toHaveLength(1);

			// Next message inside the window: only the user left out last time.
			await dispatchPush(fcmEnv, { kind: "group_message", authorId: author.id, groupId });
			expect(sends).toHaveLength(MAX_RECIPIENTS + 1);
			expect(owner.get(sends[MAX_RECIPIENTS]?.token ?? "")).toBe(left[0]?.id);
		},
	);

	it("releases the claim when every send to a user failed, keeps it when one succeeded", async () => {
		const author = await tagalongUser({ old: true });
		const ok = await tagalongUser({ old: true });
		const failing = await tagalongUser({ old: true });
		const { groupId } = await groupWith(author, ok, failing);
		for (const u of [ok, failing])
			await env.DB.prepare("INSERT INTO notification_prefs (user_id, group_message) VALUES (?, 1)")
				.bind(u.id)
				.run();
		const okTok = await addDevice(ok.id);
		const bad = new Set([await addDevice(failing.id), await addDevice(failing.id)]);
		const room = `group:${groupId}`;

		const sends = mockFcm((t) =>
			bad.has(t)
				? json({ error: { status: "UNAVAILABLE", message: "try later" } }, 503)
				: json({ name: "projects/x/m/1" }),
		);
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: author.id, groupId });
		expect(sends.map((s) => s.token).sort()).toEqual([okTok, ...bad].sort());
		expect(await throttleRows(room)).toEqual([ok.id]);

		// The failed user is tried again on the next message; the reached one is throttled.
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: author.id, groupId });
		const second = sends.slice(3).map((s) => s.token);
		expect(second.sort()).toEqual([...bad].sort());
	});
});

const idToken = (claims: Record<string, unknown>) => {
	const enc = (o: unknown) =>
		btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
};
const challengeOf = async (verifier: string) =>
	b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

async function startNative(verifier: string) {
	const start = await call(
		`/auth/google/start?native=1&code_challenge=${await challengeOf(verifier)}`,
	);
	expect(start.status).toBe(302);
	const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
	const cookie = (start.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
	return { state, cookie };
}

describe("native callback with a lost tg_oauth cookie", () => {
	it("still redirects to the fixed app URL with error=bad_state", async () => {
		const { state } = await startNative(b64url(crypto.getRandomValues(new Uint8Array(48))));
		expect(state.startsWith("n.")).toBe(true);
		const res = await call(`/auth/google/callback?state=${encodeURIComponent(state)}&code=abc`);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${APP}?error=bad_state`);
	});

	it("a web flow without the cookie is still the 400", async () => {
		const start = await call("/auth/google/start");
		const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
		expect(state.startsWith("n.")).toBe(false);
		const res = await call(`/auth/google/callback?state=${state}&code=abc`);
		expect(res.status).toBe(400);
	});
});

describe("native sign-in interstitial", () => {
	it("shows who signed in, escaped, with strict headers and a link to the fixed callback", async () => {
		const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
		const { state, cookie } = await startNative(verifier);
		const sub = `g-${crypto.randomUUID()}`;
		const email = `o'brien+${sub.slice(2, 10)}@example.com`;
		mockFetch((url) =>
			url.hostname === "oauth2.googleapis.com"
				? json({
						id_token: idToken({
							iss: "https://accounts.google.com",
							aud: env.GOOGLE_CLIENT_ID,
							sub,
							exp: Math.floor(Date.now() / 1000) + 600,
							email,
							email_verified: true,
						}),
					})
				: undefined,
		);
		const res = await call(`/auth/google/callback?state=${state}&code=abc`, { cookie });
		vi.restoreAllMocks();

		expect(res.status).toBe(200);
		expect(res.headers.get("Location")).toBeNull();
		expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain("script-src");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.getSetCookie().some((h) => h.startsWith("tg_session="))).toBe(false);

		const html = await res.text();
		expect(html).not.toMatch(/<script/i);
		expect(html).toContain(`Signed in as ${email.replace("'", "&#39;")}`);
		expect(html).not.toContain(email);
		expect(html).toContain("If you didn't start signing in to the Budgetrip app, close this page.");

		const href = (html.match(/href="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&");
		expect(href.startsWith(`${APP}?code=`)).toBe(true);
		const code = new URL(href.replace(/^[^:]+:/, "https:")).searchParams.get("code") ?? "";
		const ex = await call("/auth/native/exchange", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "capacitor://localhost" },
			body: JSON.stringify({ code, code_verifier: verifier }),
		});
		expect(ex.status).toBe(200);
	});
});
