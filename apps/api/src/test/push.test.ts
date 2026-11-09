import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS, formatMoney } from "@tagalong/shared";
import { dispatchPush } from "../push/dispatch.js";
import {
	call,
	connect,
	groupWith,
	json,
	makeEvent,
	makeEventPlan,
	mockFetch,
	postJson,
	signedInUser,
	tagalongUser,
} from "./helpers.js";

afterEach(() => {
	vi.restoreAllMocks();
});

const token = (label: string) => `tok-${label}-${crypto.randomUUID()}`;

async function deviceRow(t: string) {
	return env.DB.prepare("SELECT user_id, disabled_at FROM push_devices WHERE token = ?")
		.bind(t)
		.first<{ user_id: string; disabled_at: string | null }>();
}

describe("push devices", () => {
	it("registers, moves a token to its new owner, and only unregisters your own", async () => {
		const a = await signedInUser();
		const b = await signedInUser();
		const t = token("shared");

		expect((await postJson("/push/devices", { platform: "ios", token: t }, a.cookie)).status).toBe(
			204,
		);
		expect((await deviceRow(t))?.user_id).toBe(a.id);

		// b can't remove a's device, and the answer doesn't say whether it exists.
		expect((await postJson("/push/devices/unregister", { token: t }, b.cookie)).status).toBe(204);
		expect((await deviceRow(t))?.user_id).toBe(a.id);

		// Re-registering on b's account moves it.
		expect(
			(await postJson("/push/devices", { platform: "android", token: t }, b.cookie)).status,
		).toBe(204);
		expect((await deviceRow(t))?.user_id).toBe(b.id);

		// Now a's unregister is the no-op, and b's removes it.
		await postJson("/push/devices/unregister", { token: t }, a.cookie);
		expect(await deviceRow(t)).not.toBeNull();
		expect((await postJson("/push/devices/unregister", { token: t }, b.cookie)).status).toBe(204);
		expect(await deviceRow(t)).toBeNull();
	});

	it("keeps at most 10 active devices per user", async () => {
		const a = await signedInUser();
		for (let i = 0; i < 11; i++) {
			const res = await postJson(
				"/push/devices",
				{ platform: "ios", token: token(`d${i}`) },
				a.cookie,
			);
			expect(res.status).toBe(204);
		}
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM push_devices WHERE user_id = ? AND disabled_at IS NULL",
		)
			.bind(a.id)
			.first<{ n: number }>();
		expect(row?.n).toBe(10);
	});

	it("needs sign-in and a trusted write", async () => {
		const a = await signedInUser();
		expect((await postJson("/push/devices", { platform: "ios", token: token("x") })).status).toBe(
			401,
		);
		expect(
			(
				await postJson(
					"/push/devices",
					{ platform: "ios", token: token("x") },
					a.cookie,
					"https://evil.example",
				)
			).status,
		).toBe(403);
		expect(
			(await postJson("/push/devices", { platform: "web", token: token("x") }, a.cookie)).status,
		).toBe(400);
	});
});

describe("notification prefs", () => {
	it("returns the defaults, then applies a partial update", async () => {
		const a = await signedInUser();
		const first = await call("/me/notifications", { cookie: a.cookie });
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual(DEFAULT_NOTIFICATION_PREFS);

		const upd = await postJson("/me/notifications", { group_message: true, dm: false }, a.cookie);
		expect(upd.status).toBe(200);
		const want = { ...DEFAULT_NOTIFICATION_PREFS, group_message: true, dm: false };
		expect(await upd.json()).toEqual(want);

		const again = await postJson("/me/notifications", { price_drop: false }, a.cookie);
		expect(await again.json()).toEqual({ ...want, price_drop: false });

		const read = await call("/me/notifications", { cookie: a.cookie });
		expect(await read.json()).toEqual({ ...want, price_drop: false });

		expect((await postJson("/me/notifications", {}, a.cookie)).status).toBe(400);
		expect((await postJson("/me/notifications", { nope: true }, a.cookie)).status).toBe(400);
	});
});

describe("push dispatch", () => {
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
		fcmEnv = {
			...env,
			FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
				project_id: "tagalong-push-test",
				client_email: "push@tagalong-push-test.iam.gserviceaccount.com",
				private_key: pem,
			}),
		};
	});

	it("sends a DM push to the other party with no message body in it", async () => {
		const a = await tagalongUser({ old: true, ack: true });
		const b = await tagalongUser({ old: true, ack: true });
		await groupWith(a, b);
		const connectionId = await connect(a, b);
		const secret = "meet me at 12 Secret Street at 9";
		// The route's own hook is a no-op here: the test env has no FCM secret.
		const sent = await postJson(`/dms/${connectionId}/messages`, { body: secret }, a.cookie);
		expect(sent.status).toBe(201);

		const bToken = token("b");
		const aToken = token("a");
		await postJson("/push/devices", { platform: "android", token: bToken }, b.cookie);
		await postJson("/push/devices", { platform: "ios", token: aToken }, a.cookie);

		const bodies: string[] = [];
		const { calls } = mockFetch(
			(url) =>
				url.host === "oauth2.googleapis.com"
					? json({ access_token: "ya29.test", expires_in: 3600 })
					: undefined,
			(url, init) => {
				if (url.host !== "fcm.googleapis.com") return undefined;
				bodies.push(String(init?.body ?? ""));
				return json({ name: "projects/x/messages/1" });
			},
		);

		await dispatchPush(fcmEnv, { kind: "dm", authorId: a.id, connectionId });

		expect(calls.filter((u) => u.host === "fcm.googleapis.com")).toHaveLength(1);
		const [raw] = bodies;
		expect(raw).toBeDefined();
		expect(raw).not.toContain(secret);
		expect(raw).not.toContain("Secret Street");
		expect(raw).not.toContain(aToken); // never the author's own device
		const msg = (
			JSON.parse(raw ?? "{}") as {
				message: {
					token: string;
					notification: { title: string; body: string };
					data: Record<string, string>;
				};
			}
		).message;
		expect(msg.token).toBe(bToken);
		expect(msg.notification).toEqual({ title: "New message", body: `From ${a.name}` });
		expect(msg.data).toEqual({ kind: "dm", path: `/dm/${connectionId}` });

		// Throttled: a second message in the same DM within the window sends nothing.
		await dispatchPush(fcmEnv, { kind: "dm", authorId: a.id, connectionId });
		expect(calls.filter((u) => u.host === "fcm.googleapis.com")).toHaveLength(1);
	});
	function mockFcm() {
		const bodies: string[] = [];
		mockFetch(
			(url) =>
				url.host === "oauth2.googleapis.com"
					? json({ access_token: "ya29.test", expires_in: 3600 })
					: undefined,
			(url, init) => {
				if (url.host !== "fcm.googleapis.com") return undefined;
				bodies.push(String(init?.body ?? ""));
				return json({ name: "projects/x/messages/1" });
			},
		);
		return bodies;
	}

	it("sends a group push only to members who turned group pushes on", async () => {
		const a = await tagalongUser({ old: true });
		const b = await tagalongUser({ old: true });
		const c = await tagalongUser({ old: true });
		const { groupId } = await groupWith(a, b, c);
		const bToken = token("gb");
		const cToken = token("gc");
		await postJson("/push/devices", { platform: "ios", token: bToken }, b.cookie);
		await postJson("/push/devices", { platform: "ios", token: cToken }, c.cookie);
		await postJson("/me/notifications", { group_message: true }, b.cookie); // c keeps the default (off)

		const bodies = mockFcm();
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: a.id, groupId });
		expect(bodies).toHaveLength(1);
		const msg = JSON.parse(bodies[0] ?? "{}").message;
		expect(msg.token).toBe(bToken);
		expect(msg.notification).toEqual({ title: "New messages", body: "In the Leafs vs Habs group" });
		expect(msg.data).toEqual({ kind: "group_message", path: `/groups/${groupId}` });
	});

	it("pushes a price drop with the stored amount and records pushed_at", async () => {
		const u = await signedInUser();
		const planId = await makeEventPlan(u.id, await makeEvent("Raptors vs Celtics"));
		const plan = await env.DB.prepare("SELECT trip_request_id FROM plans WHERE id = ?")
			.bind(planId)
			.first<{ trip_request_id: string }>();
		const alertId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO price_alerts (id, user_id, trip_request_id, plan_id, old_total_minor, new_total_minor, currency)
			 VALUES (?, ?, ?, ?, 50000, 41234, 'CAD')`,
		)
			.bind(alertId, u.id, plan?.trip_request_id, planId)
			.run();
		await postJson("/push/devices", { platform: "android", token: token("pd") }, u.cookie);

		const bodies = mockFcm();
		await dispatchPush(fcmEnv, { kind: "price_drop", alertId });
		expect(bodies).toHaveLength(1);
		const msg = JSON.parse(bodies[0] ?? "{}").message;
		const price = formatMoney({ amount_minor: 41234, currency: "CAD" });
		expect(msg.notification).toEqual({
			title: "Price drop",
			body: `Raptors vs Celtics is now ${price}`,
		});
		expect(msg.data).toEqual({ kind: "price_drop", path: `/plans/${planId}` });
		const row = await env.DB.prepare("SELECT pushed_at, push_error FROM price_alerts WHERE id = ?")
			.bind(alertId)
			.first<{ pushed_at: string | null; push_error: string | null }>();
		expect(row?.pushed_at).not.toBeNull();
		expect(row?.push_error).toBeNull();

		// Already pushed: a second dispatch sends nothing.
		await dispatchPush(fcmEnv, { kind: "price_drop", alertId });
		expect(bodies).toHaveLength(1);
	});
});
