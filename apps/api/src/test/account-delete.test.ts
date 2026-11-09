/**
 * Phase 7 smoke tests: POST /me/delete. test-engineer extends these.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptRefreshToken } from "../auth/apple.js";
import { issueBearer } from "../auth/session.js";
import app from "../index.js";
import { DELETED_MESSAGE_BODY } from "../routes/account.js";
import {
	API,
	call,
	connect,
	groupWith,
	makeEventPlan,
	makeEvent,
	mockFetch,
	postJson,
	signedInUser,
	tagalongUser,
	WEB,
} from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const count = async (sql: string, ...binds: unknown[]) =>
	(
		await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
			.bind(...binds)
			.first<{ n: number }>()
	)?.n ?? -1;

const sendGroup = async (groupId: string, cookie: string, body: string) => {
	const res = await postJson(`/groups/${groupId}/messages`, { body }, cookie);
	expect(res.status).toBe(201);
	return (await res.json<{ message: { id: string } }>()).message.id;
};

describe("POST /me/delete", () => {
	it("needs the typed confirmation, a trusted origin and a session", async () => {
		const u = await signedInUser();
		expect((await postJson("/me/delete", {}, u.cookie)).status).toBe(400);
		expect((await postJson("/me/delete", { confirm: "delete" }, u.cookie)).status).toBe(400);
		expect((await postJson("/me/delete", { confirm: "DELETE", extra: 1 }, u.cookie)).status).toBe(
			400,
		);
		expect(
			(await postJson("/me/delete", { confirm: "DELETE" }, u.cookie, "https://evil.example"))
				.status,
		).toBe(403);
		expect((await postJson("/me/delete", { confirm: "DELETE" })).status).toBe(401);
		expect((await call("/me", { cookie: u.cookie })).status).toBe(200);
	});

	it("deletes the user's data, tombstones the row, keeps reported text, and ends every session", async () => {
		const a = await tagalongUser({ old: true, ack: true });
		const b = await tagalongUser({ old: true, ack: true });
		const { groupId } = await groupWith(a, b);
		const connId = await connect(a, b);
		const kept = await sendGroup(groupId, a.cookie, "reported text");
		const gone = await sendGroup(groupId, a.cookie, "ordinary text");
		const rep = await postJson(
			"/reports",
			{ target_type: "message", target_id: kept, reason: "spam" },
			b.cookie,
		);
		expect([200, 201]).toContain(rep.status);
		// a reports b too: reports BY the user are kept.
		await postJson("/reports", { target_type: "user", target_id: b.id, reason: "other" }, a.cookie);
		await postJson("/blocks", { user_id: b.id }, a.cookie);

		const planId = await makeEventPlan(a.id, await makeEvent(), "package");
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, currency)
				 SELECT user_id, id, trip_request_id, id, 'CAD' FROM plans WHERE id = ?`,
			).bind(planId),
			env.DB.prepare("INSERT INTO share_links (token, plan_id, user_id) VALUES (?, ?, ?)").bind(
				`tok-${crypto.randomUUID()}`,
				planId,
				a.id,
			),
			env.DB.prepare(
				"INSERT INTO push_devices (id, user_id, platform, token) VALUES (?, ?, 'ios', ?)",
			).bind(crypto.randomUUID(), a.id, `tok-${crypto.randomUUID()}`),
			env.DB.prepare("INSERT INTO notification_prefs (user_id, dm) VALUES (?, 0)").bind(a.id),
			env.DB.prepare(
				"UPDATE users SET tagalong_suspended_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
			).bind(a.id),
		]);
		const bearer = (await issueBearer(env, a.id)).token;

		const res = await postJson("/me/delete", { confirm: "DELETE" }, a.cookie);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.getSetCookie().some((h) => /^tg_session=;/.test(h))).toBe(true);

		// Every credential is dead.
		expect((await call("/me", { cookie: a.cookie })).status).toBe(401);
		expect((await call("/me", { headers: { Authorization: `Bearer ${bearer}` } })).status).toBe(
			401,
		);

		for (const [table, col] of [
			["trip_requests", "user_id"],
			["plans", "user_id"],
			["saved_trips", "user_id"],
			["share_links", "user_id"],
			["push_devices", "user_id"],
			["notification_prefs", "user_id"],
			["group_members", "user_id"],
			["blocks", "blocker_id"],
		] as const)
			expect(await count(`${table} WHERE ${col} = ?`, a.id), table).toBe(0);
		expect(await count("packages WHERE plan_id = ?", planId)).toBe(0);
		expect(await count("connections WHERE id = ? AND status = 'closed'", connId)).toBe(1);

		const user = await env.DB.prepare(
			`SELECT google_sub, email, display_name, home_city, home_lat, tagalong_name, tagalong_city,
			   tagalong_opt_in_at, tagalong_suspended_at, apple_sub, deleted_at FROM users WHERE id = ?`,
		)
			.bind(a.id)
			.first<Record<string, unknown>>();
		expect(user).toMatchObject({
			google_sub: `deleted:${a.id}`,
			email: "",
			display_name: "Deleted user",
			home_city: null,
			home_lat: null,
			tagalong_name: null,
			tagalong_city: null,
			tagalong_opt_in_at: null,
			tagalong_suspended_at: "2026-01-01T00:00:00.000Z",
			apple_sub: null,
		});
		expect(user?.deleted_at).toBeTruthy();

		const msgs = await env.DB.prepare(
			"SELECT id, body, deleted_at, deleted_by FROM messages WHERE id IN (?, ?)",
		)
			.bind(kept, gone)
			.all<{ id: string; body: string; deleted_at: string | null; deleted_by: string }>();
		const byId = Object.fromEntries(msgs.results.map((m) => [m.id, m]));
		expect(byId[kept]).toMatchObject({ body: "reported text", deleted_by: "author" });
		expect(byId[gone]).toMatchObject({ body: DELETED_MESSAGE_BODY, deleted_by: "author" });
		expect(byId[kept]?.deleted_at).toBeTruthy();
		expect(await count("reports WHERE reporter_id = ?", a.id)).toBe(1);
		expect(await count("reports WHERE target_id = ?", kept)).toBe(1);

		// b sees the tombstone as "Deleted user", and none of a's messages.
		const conns = await call("/connections", { cookie: b.cookie });
		const list = await conns.json<{ connections: { id: string; other_name: string }[] }>();
		expect(list.connections.find((x) => x.id === connId)?.other_name).toBe("Deleted user");
		const hist = await call(`/groups/${groupId}/messages`, { cookie: b.cookie });
		const page = await hist.json<{ messages: { user_id: string }[] }>();
		expect(page.messages.some((m) => m.user_id === a.id)).toBe(false);
		const group = await call(`/groups/${groupId}`, { cookie: b.cookie });
		const detail = await group.json<{ members: { user_id: string }[] }>();
		expect(detail.members.some((m) => m.user_id === a.id)).toBe(false);
	});

	it("revokes a Sign in with Apple token first, and the Apple ID then gets a fresh account", async () => {
		const u = await signedInUser();
		const appleSub = `del-${crypto.randomUUID()}`;
		await env.DB.prepare(
			"UPDATE users SET apple_sub = ?, google_sub = 'apple:' || ?, apple_refresh_token_enc = ? WHERE id = ?",
		)
			.bind(appleSub, appleSub, await encryptRefreshToken(env, "rt-to-revoke"), u.id)
			.run();
		const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
			"sign",
		])) as CryptoKeyPair;
		const der = new Uint8Array(
			(await crypto.subtle.exportKey("pkcs8", ec.privateKey)) as ArrayBuffer,
		);
		const appleEnv = {
			...env,
			APPLE_SERVICES_ID: "com.averrow.budgetrip.signin",
			APPLE_TEAM_ID: "TEAM123456",
			APPLE_KEY_ID: "KEY1234567",
			APPLE_PRIVATE_KEY: btoa(String.fromCharCode(...der)),
		} as unknown as Env;

		const revoked: URLSearchParams[] = [];
		mockFetch((url, init) => {
			if (url.href !== "https://appleid.apple.com/auth/revoke") return undefined;
			revoked.push(new URLSearchParams(String(init?.body ?? "")));
			return new Response(null, { status: 200 });
		});
		const ctx = createExecutionContext();
		const res = await app.fetch(
			new Request(`${API}/me/delete`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: WEB, Cookie: u.cookie },
				body: JSON.stringify({ confirm: "DELETE" }),
			}),
			appleEnv,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect(revoked).toHaveLength(1);
		expect(revoked[0]?.get("token")).toBe("rt-to-revoke");
		expect(revoked[0]?.get("token_type_hint")).toBe("refresh_token");
		expect(revoked[0]?.get("client_id")).toBe("com.averrow.budgetrip.signin");

		// The Apple sub is free again; a new row for it doesn't collide with the tombstone.
		await env.DB.prepare(
			`INSERT INTO users (id, google_sub, apple_sub, email, display_name)
			 VALUES (?, 'apple:' || ?, ?, '', 'Traveller')`,
		)
			.bind(crypto.randomUUID(), appleSub, appleSub)
			.run();
		expect(await count("users WHERE apple_sub = ?", appleSub)).toBe(1);
	});

	it("still deletes when Apple's revoke fails", async () => {
		const u = await signedInUser();
		await env.DB.prepare("UPDATE users SET apple_refresh_token_enc = ? WHERE id = ?")
			.bind(await encryptRefreshToken(env, "rt"), u.id)
			.run();
		// No Apple config in the default env: revoke is skipped (logged), deletion proceeds.
		const res = await postJson("/me/delete", { confirm: "DELETE" }, u.cookie);
		expect(res.status).toBe(200);
		expect(await count("users WHERE id = ? AND deleted_at IS NOT NULL", u.id)).toBe(1);
	});
});
