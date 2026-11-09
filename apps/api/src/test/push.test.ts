import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS } from "@tagalong/shared";
import { dispatchPush } from "../push/dispatch.js";
import {
	call,
	connect,
	groupWith,
	json,
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
});
