/**
 * Phase 6 push dispatch: who is skipped, what each payload says, device
 * failure handling, the no-secret no-op, the fan-out cap, message privacy, and
 * price-drop figures. Every outbound call (Google OAuth, FCM, providers,
 * Resend) is mocked.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatMoney } from "@tagalong/shared";
import { checkSavedTrips } from "../planning/alerts.js";
import { dispatchPush, MAX_SENDS, notify, type PushEvent } from "../push/dispatch.js";
import {
	call,
	connect,
	groupWith,
	json,
	joinGroup,
	makeEvent,
	makeEventPlan,
	mockFetch,
	postJson,
	signedInUser,
	tagalongUser,
	type TgUser,
} from "./helpers.js";

const mutableEnv = env as unknown as Record<string, string | undefined>;

afterEach(() => {
	vi.restoreAllMocks();
	delete mutableEnv.FCM_SERVICE_ACCOUNT_JSON;
	delete mutableEnv.RESEND_API_KEY;
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
		project_id: "tagalong-dispatch-test",
		client_email: "push@tagalong-dispatch-test.iam.gserviceaccount.com",
		private_key: pem,
	});
	fcmEnv = { ...env, FCM_SERVICE_ACCOUNT_JSON: fcmSecret };
});

const tok = (label: string) => `tok-${label}-${crypto.randomUUID()}`;

interface Sent {
	token: string;
	title: string;
	body: string;
	data: Record<string, string>;
	raw: string;
}

/**
 * Mocks Google OAuth + FCM. `reply` picks the FCM answer per device token.
 * `all` records every outbound body (OAuth included) for leak checks.
 */
function mockFcm(
	reply: (token: string) => Response = () => json({ name: "projects/x/messages/1" }),
) {
	const sends: Sent[] = [];
	const all: string[] = [];
	const m = mockFetch(
		(url, init) => {
			if (url.host !== "oauth2.googleapis.com") return undefined;
			all.push(String(init?.body ?? ""));
			return json({ access_token: "ya29.dispatch", expires_in: 3600 });
		},
		(url, init) => {
			if (url.host !== "fcm.googleapis.com") return undefined;
			const raw = String(init?.body ?? "");
			all.push(raw);
			const msg = (
				JSON.parse(raw) as {
					message: {
						token: string;
						notification: { title: string; body: string };
						data: Record<string, string>;
					};
				}
			).message;
			sends.push({
				token: msg.token,
				title: msg.notification.title,
				body: msg.notification.body,
				data: msg.data,
				raw,
			});
			return reply(msg.token);
		},
	);
	return { sends, all, calls: m.calls };
}

async function addDevice(userId: string, label = "d"): Promise<string> {
	const t = tok(label);
	await env.DB.prepare(
		"INSERT INTO push_devices (id, user_id, platform, token) VALUES (?, ?, 'android', ?)",
	)
		.bind(crypto.randomUUID(), userId, t)
		.run();
	return t;
}

async function setPrefs(userId: string, prefs: Partial<Record<string, 0 | 1>>) {
	const cols = Object.keys(prefs);
	await env.DB.prepare(
		`INSERT INTO notification_prefs (user_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})
		 ON CONFLICT (user_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`,
	)
		.bind(userId, ...Object.values(prefs))
		.run();
}

const block = (blocker: string, blocked: string) =>
	env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)")
		.bind(blocker, blocked)
		.run();
const suspend = (id: string) =>
	env.DB.prepare("UPDATE users SET tagalong_suspended_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), id)
		.run();
const optOut = (id: string) =>
	env.DB.prepare("UPDATE users SET tagalong_opt_in_at = NULL WHERE id = ?").bind(id).run();
const underage = (id: string) =>
	env.DB.prepare("UPDATE users SET birthdate_verified_18 = 0 WHERE id = ?").bind(id).run();

/** Two acked, trusted Tagalong users who share a group and an accepted DM. */
async function dmPair(): Promise<{ a: TgUser; b: TgUser; connectionId: string }> {
	const a = await tagalongUser({ old: true, ack: true });
	const b = await tagalongUser({ old: true, ack: true });
	await groupWith(a, b);
	const connectionId = await connect(a, b);
	return { a, b, connectionId };
}

describe("dispatch: who is skipped", () => {
	it("group: skips blocked (both ways), suspended, opted-out, under-18, prefs-off and the author", async () => {
		const author = await tagalongUser({ old: true });
		const blockedByAuthor = await tagalongUser({ old: true });
		const blocksAuthor = await tagalongUser({ old: true });
		const suspended = await tagalongUser({ old: true });
		const optedOut = await tagalongUser({ old: true });
		const minor = await tagalongUser({ old: true });
		const prefsOff = await tagalongUser({ old: true });
		const ok = await tagalongUser({ old: true });
		const all = [author, blockedByAuthor, blocksAuthor, suspended, optedOut, minor, prefsOff, ok];
		const { groupId } = await groupWith(...all);

		const tokens = new Map<string, string>();
		for (const u of all) {
			tokens.set(u.id, await addDevice(u.id));
			if (u !== prefsOff) await setPrefs(u.id, { group_message: 1 });
		}
		await setPrefs(prefsOff.id, { group_message: 0 });
		await block(author.id, blockedByAuthor.id);
		await block(blocksAuthor.id, author.id);
		await suspend(suspended.id);
		await optOut(optedOut.id);
		await underage(minor.id);

		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: author.id, groupId });
		expect(fcm.sends.map((s) => s.token)).toEqual([tokens.get(ok.id)]);
	});

	it("dm: a block either way, suspension, opt-out, under-18 or dm off sends nothing", async () => {
		const cases: [string, (p: Awaited<ReturnType<typeof dmPair>>) => Promise<unknown>][] = [
			["author blocked recipient", (p) => block(p.a.id, p.b.id)],
			["recipient blocked author", (p) => block(p.b.id, p.a.id)],
			["recipient suspended", (p) => suspend(p.b.id)],
			["recipient opted out", (p) => optOut(p.b.id)],
			["recipient under 18", (p) => underage(p.b.id)],
			["recipient turned dm off", (p) => setPrefs(p.b.id, { dm: 0 })],
		];
		for (const [label, setup] of cases) {
			const p = await dmPair();
			await addDevice(p.b.id);
			await addDevice(p.a.id);
			await setup(p);
			const fcm = mockFcm();
			await dispatchPush(fcmEnv, { kind: "dm", authorId: p.a.id, connectionId: p.connectionId });
			expect(fcm.sends, label).toHaveLength(0);
			vi.restoreAllMocks();
		}
		// Control: the same setup with nothing wrong does send, to the other party only.
		const p = await dmPair();
		const bTok = await addDevice(p.b.id);
		await addDevice(p.a.id);
		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "dm", authorId: p.a.id, connectionId: p.connectionId });
		expect(fcm.sends.map((s) => s.token)).toEqual([bTok]);
	});

	it("dm: an author who isn't a party to the connection notifies nobody", async () => {
		const p = await dmPair();
		const stranger = await tagalongUser({ old: true });
		await addDevice(p.a.id);
		await addDevice(p.b.id);
		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "dm", authorId: stranger.id, connectionId: p.connectionId });
		expect(fcm.sends).toHaveLength(0);
	});

	it("connection request: a block either way (even with the request still pending) sends nothing", async () => {
		for (const dir of ["from blocks to", "to blocks from"] as const) {
			const from = await tagalongUser({ old: true, ack: true });
			const to = await tagalongUser({ old: true, ack: true });
			await groupWith(from, to);
			const asked = await postJson("/connections", { user_id: to.id }, from.cookie);
			expect(asked.status).toBe(200);
			const { connection } = await asked.json<{ connection: { id: string } }>();
			await addDevice(to.id);
			// Inserted directly so the connection stays pending: only the dispatch gate can stop it.
			if (dir === "from blocks to") await block(from.id, to.id);
			else await block(to.id, from.id);
			const fcm = mockFcm();
			await dispatchPush(fcmEnv, {
				kind: "connection_request",
				connectionId: connection.id,
				fromUserId: from.id,
				toUserId: to.id,
			});
			expect(fcm.sends, dir).toHaveLength(0);
			vi.restoreAllMocks();
		}
	});

	it("never notifies the author, even when they are the only one with a device", async () => {
		const a = await tagalongUser({ old: true });
		const b = await tagalongUser({ old: true });
		const { groupId } = await groupWith(a, b);
		await addDevice(a.id);
		await setPrefs(a.id, { group_message: 1 });
		await setPrefs(b.id, { group_message: 1 }); // b has no device
		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: a.id, groupId });
		expect(fcm.sends).toHaveLength(0);
		// And the author is never handed a throttle slot.
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM push_throttle WHERE user_id = ? AND room_key = ?",
		)
			.bind(a.id, `group:${groupId}`)
			.first<{ n: number }>();
		expect(row?.n).toBe(0);
	});

	it("a group push reaches only current members", async () => {
		const a = await tagalongUser({ old: true });
		const b = await tagalongUser({ old: true });
		const outsider = await tagalongUser({ old: true });
		const { groupId } = await groupWith(a, b);
		await groupWith(outsider); // in some other group
		const bTok = await addDevice(b.id);
		await addDevice(outsider.id);
		await setPrefs(b.id, { group_message: 1 });
		await setPrefs(outsider.id, { group_message: 1 });
		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: a.id, groupId });
		expect(fcm.sends.map((s) => s.token)).toEqual([bTok]);
	});
});

describe("dispatch: connection payloads", () => {
	it("request goes to the asked user; acceptance goes back to the asker; stale events send nothing", async () => {
		const from = await tagalongUser({ old: true, ack: true });
		const to = await tagalongUser({ old: true, ack: true });
		await groupWith(from, to);
		const fromTok = await addDevice(from.id, "from");
		const toTok = await addDevice(to.id, "to");

		const asked = await postJson("/connections", { user_id: to.id }, from.cookie);
		const { connection } = await asked.json<{ connection: { id: string } }>();
		const request: PushEvent = {
			kind: "connection_request",
			connectionId: connection.id,
			fromUserId: from.id,
			toUserId: to.id,
		};
		let fcm = mockFcm();
		await dispatchPush(fcmEnv, request);
		expect(fcm.sends).toHaveLength(1);
		expect(fcm.sends[0]).toMatchObject({
			token: toTok,
			title: "Connection request",
			body: `${from.name} wants to connect`,
			data: { kind: "connection_request", path: "/connections" },
		});
		vi.restoreAllMocks();

		// A request the other side made is not one "to" can claim to have sent.
		fcm = mockFcm();
		await dispatchPush(fcmEnv, { ...request, fromUserId: to.id, toUserId: from.id });
		expect(fcm.sends).toHaveLength(0);
		vi.restoreAllMocks();

		expect((await postJson(`/connections/${connection.id}/accept`, {}, to.cookie)).status).toBe(
			200,
		);
		fcm = mockFcm();
		await dispatchPush(fcmEnv, {
			kind: "connection_accepted",
			connectionId: connection.id,
			fromUserId: to.id,
			toUserId: from.id,
		});
		expect(fcm.sends).toHaveLength(1);
		expect(fcm.sends[0]).toMatchObject({
			token: fromTok,
			title: "Request accepted",
			body: `${to.name} accepted your request`,
			data: { kind: "connection_accepted", path: "/connections" },
		});

		// The request event is stale now (the connection is accepted): nothing.
		await dispatchPush(fcmEnv, request);
		expect(fcm.sends).toHaveLength(1);
	});

	it("respects connection_request / connection_accepted prefs", async () => {
		const from = await tagalongUser({ old: true, ack: true });
		const to = await tagalongUser({ old: true, ack: true });
		await groupWith(from, to);
		await addDevice(to.id);
		await setPrefs(to.id, { connection_request: 0 });
		const asked = await postJson("/connections", { user_id: to.id }, from.cookie);
		const { connection } = await asked.json<{ connection: { id: string } }>();
		const fcm = mockFcm();
		await dispatchPush(fcmEnv, {
			kind: "connection_request",
			connectionId: connection.id,
			fromUserId: from.id,
			toUserId: to.id,
		});
		expect(fcm.sends).toHaveLength(0);
	});
});

describe("dispatch: device results", () => {
	it("an invalid_token result disables that device only; other errors are recorded, not disabled", async () => {
		const p = await dmPair();
		const dead = await addDevice(p.b.id, "dead");
		const flaky = await addDevice(p.b.id, "flaky");
		const good = await addDevice(p.b.id, "good");
		const fcm = mockFcm((t) =>
			t === dead
				? json(
						{
							error: {
								code: 404,
								status: "NOT_FOUND",
								message: "Requested entity was not found.",
								details: [
									{
										"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
										errorCode: "UNREGISTERED",
									},
								],
							},
						},
						404,
					)
				: t === flaky
					? json({ error: { code: 500, status: "INTERNAL", message: "boom" } }, 500)
					: json({ name: "projects/x/messages/1" }),
		);
		await dispatchPush(fcmEnv, { kind: "dm", authorId: p.a.id, connectionId: p.connectionId });
		expect(new Set(fcm.sends.map((s) => s.token))).toEqual(new Set([dead, flaky, good]));

		const row = (t: string) =>
			env.DB.prepare("SELECT disabled_at, last_error FROM push_devices WHERE token = ?")
				.bind(t)
				.first<{ disabled_at: string | null; last_error: string | null }>();
		const d = await row(dead);
		expect(d?.disabled_at).not.toBeNull();
		expect(d?.last_error).toContain("UNREGISTERED");
		const f = await row(flaky);
		expect(f?.disabled_at).toBeNull();
		expect(f?.last_error).toMatch(/^retryable: /);
		expect(await row(good)).toEqual({ disabled_at: null, last_error: null });

		// The dead device is never tried again (throttle cleared to allow a second push).
		await env.DB.prepare("DELETE FROM push_throttle WHERE user_id = ?").bind(p.b.id).run();
		vi.restoreAllMocks();
		const again = mockFcm();
		await dispatchPush(fcmEnv, { kind: "dm", authorId: p.a.id, connectionId: p.connectionId });
		expect(again.sends.map((s) => s.token)).not.toContain(dead);
		expect(again.sends).toHaveLength(2);
	});

	it("tries at most the 3 newest active devices per recipient", async () => {
		const p = await dmPair();
		const toks: string[] = [];
		for (let i = 0; i < 5; i++) {
			const t = await addDevice(p.b.id, `n${i}`);
			await env.DB.prepare("UPDATE push_devices SET last_seen_at = ? WHERE token = ?")
				.bind(new Date(Date.now() - (10 - i) * 60_000).toISOString(), t)
				.run();
			toks.push(t);
		}
		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "dm", authorId: p.a.id, connectionId: p.connectionId });
		expect(new Set(fcm.sends.map((s) => s.token))).toEqual(new Set(toks.slice(2)));
	});
});

describe("dispatch: no FCM secret", () => {
	it("dispatchPush touches neither the network nor D1 for any kind", async () => {
		expect(env.FCM_SERVICE_ACCOUNT_JSON).toBeUndefined();
		const prepare = vi.fn();
		const batch = vi.fn();
		const exec = vi.fn();
		const noDb = { ...env, DB: { prepare, batch, exec } as unknown as D1Database };
		const m = mockFetch();
		const events: PushEvent[] = [
			{ kind: "dm", authorId: "a", connectionId: "c" },
			{ kind: "group_message", authorId: "a", groupId: "g" },
			{ kind: "connection_request", connectionId: "c", fromUserId: "a", toUserId: "b" },
			{ kind: "connection_accepted", connectionId: "c", fromUserId: "a", toUserId: "b" },
			{ kind: "price_drop", alertId: "x" },
		];
		for (const e of events) await dispatchPush(noDb, e);
		const defer = vi.fn();
		for (const e of events) notify(noDb, defer, e);
		expect(defer).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		expect(batch).not.toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalled();
		expect(m.calls).toHaveLength(0);
	});

	it("real DM, group and connection routes write no push_throttle rows and fetch nothing", async () => {
		const p = await dmPair();
		const { groupId } = await groupWith(p.a, p.b);
		await addDevice(p.b.id);
		await addDevice(p.a.id);
		await setPrefs(p.b.id, { group_message: 1 });
		const m = mockFetch();
		expect(
			(await postJson(`/dms/${p.connectionId}/messages`, { body: "hi there" }, p.a.cookie)).status,
		).toBe(201);
		expect(
			(await postJson(`/groups/${groupId}/messages`, { body: "hello group" }, p.a.cookie)).status,
		).toBe(201);
		const c = await tagalongUser({ old: true, ack: true });
		await joinGroup(c, groupId);
		await addDevice(c.id);
		expect((await postJson("/connections", { user_id: c.id }, p.a.cookie)).status).toBe(200);

		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM push_throttle WHERE user_id IN (?, ?, ?)",
		)
			.bind(p.a.id, p.b.id, c.id)
			.first<{ n: number }>();
		expect(rows?.n).toBe(0);
		expect(
			m.calls.filter((u) => u.host === "fcm.googleapis.com" || u.host === "oauth2.googleapis.com"),
		).toHaveLength(0);
	});
});

describe("dispatch: fan-out cap", () => {
	it(`sends at most ${MAX_SENDS} device pushes per event, spread fairly`, async () => {
		const author = await tagalongUser({ old: true });
		const members: TgUser[] = [];
		for (let i = 0; i < 20; i++) members.push(await tagalongUser({ old: true }));
		const { groupId } = await groupWith(author, ...members);
		const owner = new Map<string, string>();
		for (const m of members) {
			await setPrefs(m.id, { group_message: 1 });
			for (let d = 0; d < 3; d++) owner.set(await addDevice(m.id, `fan${d}`), m.id);
		}
		expect(owner.size).toBe(60);

		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: author.id, groupId });
		expect(MAX_SENDS).toBeLessThanOrEqual(49);
		expect(fcm.sends.length).toBeLessThanOrEqual(MAX_SENDS);
		expect(fcm.sends.length).toBe(MAX_SENDS);
		// Total outbound subrequests (token + sends) within 50.
		expect(fcm.calls.length).toBeLessThanOrEqual(50);
		const perUser = new Map<string, number>();
		for (const s of fcm.sends) {
			const id = owner.get(s.token);
			expect(id).toBeDefined();
			perUser.set(id ?? "", (perUser.get(id ?? "") ?? 0) + 1);
		}
		expect(perUser.size).toBe(20); // every member got something
		for (const n of perUser.values()) expect(n).toBeGreaterThanOrEqual(2);
	});
});

describe("dispatch: no message text in any outbound body", () => {
	const secretText = "meet me at 42 Hidden Lane, flat 7, code 9911";

	it("dm, through the real route with FCM configured", async () => {
		const p = await dmPair();
		const bTok = await addDevice(p.b.id);
		mutableEnv.FCM_SERVICE_ACCOUNT_JSON = fcmSecret;
		const fcm = mockFcm();
		const res = await postJson(`/dms/${p.connectionId}/messages`, { body: secretText }, p.a.cookie);
		expect(res.status).toBe(201);
		expect(fcm.sends.map((s) => s.token)).toEqual([bTok]);
		expect(fcm.sends[0]).toMatchObject({ title: "New message", body: `From ${p.a.name}` });
		for (const raw of fcm.all) {
			expect(raw).not.toContain("Hidden Lane");
			expect(raw).not.toContain("9911");
			expect(raw).not.toContain("@example.com");
			expect(raw).not.toContain("Privateville");
		}
	});

	it("group, through the real route with FCM configured", async () => {
		const a = await tagalongUser({ old: true });
		const b = await tagalongUser({ old: true });
		const { groupId } = await groupWith(a, b);
		const bTok = await addDevice(b.id);
		await setPrefs(b.id, { group_message: 1 });
		mutableEnv.FCM_SERVICE_ACCOUNT_JSON = fcmSecret;
		const fcm = mockFcm();
		const res = await postJson(`/groups/${groupId}/messages`, { body: secretText }, a.cookie);
		expect(res.status).toBe(201);
		expect(fcm.sends.map((s) => s.token)).toEqual([bTok]);
		expect(fcm.sends[0]).toMatchObject({
			title: "New messages",
			data: { kind: "group_message", path: `/groups/${groupId}` },
		});
		for (const raw of fcm.all) {
			expect(raw).not.toContain("Hidden Lane");
			expect(raw).not.toContain("9911");
			expect(raw).not.toContain(a.name);
			expect(raw).not.toContain("@example.com");
		}
	});
});

describe("dispatch: price drop figures", () => {
	async function alertFor(
		userId: string,
		eventName: string,
		newMinor: number,
		currency: string,
	): Promise<{ alertId: string; planId: string }> {
		// via 'package': the plan's own package says 10000 CAD; the push must ignore it.
		const planId = await makeEventPlan(userId, await makeEvent(eventName), "package");
		await env.DB.prepare(
			"UPDATE plans SET event_id = (SELECT event_id FROM packages WHERE plan_id = ?) WHERE id = ?",
		)
			.bind(planId, planId)
			.run();
		const plan = await env.DB.prepare("SELECT trip_request_id FROM plans WHERE id = ?")
			.bind(planId)
			.first<{ trip_request_id: string }>();
		const alertId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO price_alerts (id, user_id, trip_request_id, plan_id, old_total_minor, new_total_minor, currency)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(alertId, userId, plan?.trip_request_id, planId, newMinor * 2, newMinor, currency)
			.run();
		return { alertId, planId };
	}

	it("pushes exactly formatMoney(stored minor units, currency) for JPY, CAD and KWD", async () => {
		for (const [minor, currency] of [
			[41234, "CAD"],
			[12345, "JPY"],
			[12345, "KWD"],
		] as const) {
			const u = await signedInUser();
			const { alertId, planId } = await alertFor(u.id, "Raptors vs Celtics", minor, currency);
			await addDevice(u.id);
			const fcm = mockFcm();
			await dispatchPush(fcmEnv, { kind: "price_drop", alertId });
			expect(fcm.sends, currency).toHaveLength(1);
			const price = formatMoney({ amount_minor: minor, currency });
			expect(fcm.sends[0]).toMatchObject({
				title: "Price drop",
				data: { kind: "price_drop", path: `/plans/${planId}` },
			});
			// Wording aside, the figure is exactly the stored alert through formatMoney.
			const body = fcm.sends[0]?.body ?? "";
			expect(body.startsWith("Raptors vs Celtics ")).toBe(true);
			expect(body.endsWith(` ${price}`)).toBe(true);
			// Not the package's 10000 CAD, nor the old figure.
			expect(fcm.sends[0]?.body).not.toContain(
				formatMoney({ amount_minor: 10000, currency: "CAD" }),
			);
			expect(fcm.sends[0]?.body).not.toContain(formatMoney({ amount_minor: minor * 2, currency }));
			vi.restoreAllMocks();
		}
	});

	it("price_drop off: no push and pushed_at stays empty", async () => {
		const u = await signedInUser();
		const { alertId } = await alertFor(u.id, "Jays vs Yankees", 30000, "CAD");
		await addDevice(u.id);
		await setPrefs(u.id, { price_drop: 0 });
		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "price_drop", alertId });
		expect(fcm.sends).toHaveLength(0);
		const row = await env.DB.prepare("SELECT pushed_at, push_error FROM price_alerts WHERE id = ?")
			.bind(alertId)
			.first<{ pushed_at: string | null; push_error: string | null }>();
		expect(row).toEqual({ pushed_at: null, push_error: null });
	});

	it("a failed push records push_error and is not retried", async () => {
		const u = await signedInUser();
		const { alertId } = await alertFor(u.id, "Sens vs Habs", 30000, "CAD");
		await addDevice(u.id);
		const fcm = mockFcm(() => json({ error: { code: 500, status: "INTERNAL" } }, 500));
		await dispatchPush(fcmEnv, { kind: "price_drop", alertId });
		expect(fcm.sends).toHaveLength(1);
		const row = await env.DB.prepare("SELECT pushed_at, push_error FROM price_alerts WHERE id = ?")
			.bind(alertId)
			.first<{ pushed_at: string | null; push_error: string | null }>();
		expect(row?.pushed_at).toBeNull();
		expect(row?.push_error).toMatch(/^retryable: /);
		await dispatchPush(fcmEnv, { kind: "price_drop", alertId });
		expect(fcm.sends).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// The cron path end to end: push and email side by side.
// ---------------------------------------------------------------------------

let day = 0;
const nextDate = () => new Date(Date.UTC(2028, 2, 1 + 3 * day++)).toISOString().slice(0, 10);

function providers(id: string, date: string, min: number, fcmReply?: (t: string) => Response) {
	const emails: Array<Record<string, unknown>> = [];
	const pushes: Sent[] = [];
	mockFetch(
		(url) =>
			url.hostname === "app.ticketmaster.com"
				? json({
						_embedded: {
							events: [
								{
									id,
									name: "Maple Leafs at Bruins",
									url: `https://www.ticketmaster.com/event/${id}`,
									dates: { start: { localDate: date } },
									classifications: [{ segment: { name: "Sports" } }],
									priceRanges: [{ type: "standard", currency: "USD", min, max: 300 }],
									_embedded: {
										venues: [
											{
												name: "TD Garden",
												city: { name: "Boston" },
												country: { countryCode: "US" },
												location: { latitude: "42.3662", longitude: "-71.0621" },
											},
										],
									},
								},
							],
						},
					})
				: undefined,
		(url) =>
			url.hostname === "api.frankfurter.dev"
				? json({ base: "USD", date: "2026-11-05", rates: { CAD: 1.38 } })
				: undefined,
		(url, init) => {
			if (url.hostname !== "api.resend.com") return undefined;
			emails.push(JSON.parse(String(init?.body)));
			return json({ id: "email_1" });
		},
		(url) =>
			url.host === "oauth2.googleapis.com"
				? json({ access_token: "ya29.cron", expires_in: 3600 })
				: undefined,
		(url, init) => {
			if (url.host !== "fcm.googleapis.com") return undefined;
			const msg = JSON.parse(String(init?.body)).message;
			pushes.push({
				token: msg.token,
				title: msg.notification.title,
				body: msg.notification.body,
				data: msg.data,
				raw: String(init?.body),
			});
			return fcmReply ? fcmReply(msg.token) : json({ name: "projects/x/messages/1" });
		},
	);
	return { emails, pushes };
}

const tripRequest = (query: string, date: string) => ({
	origin: { label: "Toronto, ON, Canada", lat: 43.6532, lng: -79.3832, country_code: "CA" },
	event: { query },
	date_from: date,
	date_to: date,
	party_size: 2,
	budget: { amount_minor: 400000, currency: "CAD", scope: "total" },
	prefs: {
		transport: "any",
		stay: "any",
		max_nights: 2,
		seat_quality: "any",
		vibe_tags: [],
	},
});

async function savedTrip(id: string, date: string) {
	const u = await signedInUser();
	providers(id, date, 45);
	const res = await postJson(
		"/plans",
		tripRequest(`Leafs ${id} ${crypto.randomUUID().slice(0, 6)}`, date),
		u.cookie,
	);
	expect(res.status).toBe(202);
	const { id: planId } = await res.json<{ id: string }>();
	const p = await (await call(`/plans/${planId}`, { cookie: u.cookie })).json<{ status: string }>();
	expect(p.status).toBe("done");
	expect((await postJson(`/plans/${planId}/save`, {}, u.cookie)).status).toBe(200);
	vi.restoreAllMocks();
	return u;
}

describe("price drop: cron path with push and email", () => {
	it("push and email carry the same stored figure; both are recorded", async () => {
		const date = nextDate();
		const u = await savedTrip("PUSH-CRON-1", date);
		const devTok = await addDevice(u.id);
		const { emails, pushes } = providers("PUSH-CRON-1", date, 20);
		const r = await checkSavedTrips({ ...fcmEnv, RESEND_API_KEY: "re_test" });
		expect(r.alerts).toBeGreaterThanOrEqual(1);

		const alert = await env.DB.prepare("SELECT * FROM price_alerts WHERE user_id = ?")
			.bind(u.id)
			.first<{
				plan_id: string;
				new_total_minor: number;
				old_total_minor: number;
				currency: string;
				emailed_at: string | null;
				pushed_at: string | null;
				push_error: string | null;
			}>();
		expect(alert).not.toBeNull();
		const price = formatMoney({
			amount_minor: alert?.new_total_minor ?? 0,
			currency: alert?.currency ?? "",
		});
		expect(pushes).toHaveLength(1);
		expect(pushes[0]).toMatchObject({
			token: devTok,
			title: "Price drop",
			data: { kind: "price_drop", path: `/plans/${alert?.plan_id}` },
		});
		const body = pushes[0]?.body ?? "";
		expect(body.startsWith("Maple Leafs at Bruins ")).toBe(true);
		expect(body.endsWith(` ${price}`)).toBe(true);
		expect(alert?.pushed_at).not.toBeNull();

		const mail = emails.find((m) => (m.to as string[])[0] === `${u.id}@example.com`);
		expect(mail?.subject).toBe(`Price drop: Maple Leafs at Bruins now from ${price}`);
		expect(String(mail?.text)).toContain(
			`down from ${formatMoney({ amount_minor: alert?.old_total_minor ?? 0, currency: alert?.currency ?? "" })}`,
		);
		expect(alert?.emailed_at).not.toBeNull();
	});

	it("a failing push doesn't stop the email", async () => {
		const date = nextDate();
		const u = await savedTrip("PUSH-CRON-2", date);
		await addDevice(u.id);
		const { emails, pushes } = providers("PUSH-CRON-2", date, 20, () =>
			json({ error: { code: 503, status: "UNAVAILABLE" } }, 503),
		);
		await checkSavedTrips({ ...fcmEnv, RESEND_API_KEY: "re_test" });
		expect(pushes).toHaveLength(1);
		const alert = await env.DB.prepare(
			"SELECT emailed_at, email_error, pushed_at, push_error FROM price_alerts WHERE user_id = ?",
		)
			.bind(u.id)
			.first<{
				emailed_at: string | null;
				email_error: string | null;
				pushed_at: string | null;
				push_error: string | null;
			}>();
		expect(alert?.pushed_at).toBeNull();
		expect(alert?.push_error).toMatch(/^retryable: /);
		expect(alert?.emailed_at).not.toBeNull();
		expect(alert?.email_error).toBeNull();
		expect(emails.filter((m) => (m.to as string[])[0] === `${u.id}@example.com`)).toHaveLength(1);
	});

	it("without FCM the email path is unchanged and nothing push-related is written", async () => {
		const date = nextDate();
		const u = await savedTrip("PUSH-CRON-3", date);
		await addDevice(u.id);
		const { emails, pushes } = providers("PUSH-CRON-3", date, 20);
		await checkSavedTrips({ ...env, RESEND_API_KEY: "re_test" });
		expect(pushes).toHaveLength(0);
		const alert = await env.DB.prepare(
			"SELECT emailed_at, pushed_at, push_error FROM price_alerts WHERE user_id = ?",
		)
			.bind(u.id)
			.first<{ emailed_at: string | null; pushed_at: string | null; push_error: string | null }>();
		expect(alert?.emailed_at).not.toBeNull();
		expect(alert?.pushed_at).toBeNull();
		expect(alert?.push_error).toBeNull();
		expect(emails.filter((m) => (m.to as string[])[0] === `${u.id}@example.com`)).toHaveLength(1);
	});
});

describe("dispatch: throttle and fairness", () => {
	it("a push that reached no device gives the throttle slot back; one that did keeps it", async () => {
		const p = await dmPair();
		await addDevice(p.b.id);
		const failing = mockFcm(() => json({ error: { code: 500, status: "INTERNAL" } }, 500));
		await dispatchPush(fcmEnv, { kind: "dm", authorId: p.a.id, connectionId: p.connectionId });
		expect(failing.sends).toHaveLength(1);
		const slot = () =>
			env.DB.prepare("SELECT COUNT(*) AS n FROM push_throttle WHERE user_id = ? AND room_key = ?")
				.bind(p.b.id, `dm:${p.connectionId}`)
				.first<{ n: number }>();
		expect((await slot())?.n).toBe(0);
		vi.restoreAllMocks();

		const ok = mockFcm();
		await dispatchPush(fcmEnv, { kind: "dm", authorId: p.a.id, connectionId: p.connectionId });
		expect(ok.sends).toHaveLength(1);
		expect((await slot())?.n).toBe(1);
		await dispatchPush(fcmEnv, { kind: "dm", authorId: p.a.id, connectionId: p.connectionId });
		expect(ok.sends).toHaveLength(1); // throttled now
	});

	it("a big group notifies at most MAX_SENDS people, and the next message reaches the rest", async () => {
		const author = await tagalongUser({ old: true });
		const members: TgUser[] = [];
		for (let i = 0; i < MAX_SENDS + 11; i++) members.push(await tagalongUser({ old: true }));
		const { groupId } = await groupWith(author, ...members);
		const owner = new Map<string, string>();
		for (const m of members) {
			await setPrefs(m.id, { group_message: 1 });
			owner.set(await addDevice(m.id, "big"), m.id);
		}
		const fcm = mockFcm();
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: author.id, groupId });
		expect(fcm.sends).toHaveLength(MAX_SENDS);
		const first = new Set(fcm.sends.map((s) => owner.get(s.token)));
		expect(first.size).toBe(MAX_SENDS);

		await dispatchPush(fcmEnv, { kind: "group_message", authorId: author.id, groupId });
		const second = fcm.sends.slice(MAX_SENDS).map((s) => owner.get(s.token));
		expect(second).toHaveLength(11);
		for (const id of second) expect(first.has(id)).toBe(false);
		expect(new Set([...first, ...second]).size).toBe(MAX_SENDS + 11);
	});
});
