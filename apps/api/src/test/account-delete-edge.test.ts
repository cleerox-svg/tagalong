/**
 * Phase 7: POST /me/delete, the edges. Every table emptied for the user and
 * untouched for others, FK integrity, message scrubbing, what survives
 * (reports, the suspension marker), every credential dead afterwards, how the
 * tombstone appears to others (groups, chat, connections, blocks, moderation,
 * push, price alerts), Apple revocation, CSRF / confirmation / rate limit, and
 * signing up again with the same identity.
 *
 * Every outbound call (Apple, Google, FCM, providers) is mocked.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptRefreshToken } from "../auth/apple.js";
import { issueNativeCode } from "../auth/native.js";
import { issueBearer } from "../auth/session.js";
import { identityHash } from "../auth/suspended-identity.js";
import { checkSavedTrips } from "../planning/alerts.js";
import { dispatchPush } from "../push/dispatch.js";
import { DELETED_MESSAGE_BODY, DELETED_USER_NAME } from "../routes/account.js";
import {
	assertClientSecret,
	callWith,
	cookieOf,
	ISS,
	makeAppleKit,
	mockApple,
	pkcePair,
	postAppleCallback,
	randomIp,
	SERVICES_ID,
	startApple,
	uniqueSub,
	type AppleKit,
} from "./apple-fixtures.js";
import {
	call,
	connect,
	groupWith,
	joinGroup,
	json,
	makeEvent,
	makeEventPlan,
	mockFetch,
	MODERATOR_ID,
	postJson,
	signedInUser,
	tagalongUser,
	WEB,
	type TgUser,
} from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

let kit: AppleKit;
let fcmEnv: Env;

beforeAll(async () => {
	kit = await makeAppleKit();
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
	const label = ["PRIVATE", "KEY"].join(" ");
	const pem = `-----BEGIN ${label}-----\n${(btoa(String.fromCharCode(...der)).match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;
	fcmEnv = {
		...env,
		FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
			project_id: "tagalong-delete-test",
			client_email: "push@tagalong-delete-test.iam.gserviceaccount.com",
			private_key: pem,
		}),
	};
});

const n = async (sql: string, ...binds: unknown[]) =>
	(
		await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
			.bind(...binds)
			.first<{ n: number }>()
	)?.n ?? -1;

const del = (cookie: string, body: unknown = { confirm: "DELETE" }, origin = WEB) =>
	postJson("/me/delete", body, cookie, origin);

const send = async (path: string, cookie: string, body: string) => {
	const res = await postJson(path, { body }, cookie);
	expect(res.status, `${path}: ${await res.clone().text()}`).toBe(201);
	return (await res.json<{ message: { id: string } }>()).message.id;
};

/** Gives `u` a row in every Budgetrip / push / auth table. Returns the plan id. */
async function fillBudgetrip(u: { id: string }): Promise<string> {
	const planId = await makeEventPlan(u.id, await makeEvent(), "package");
	const plan = await env.DB.prepare(
		"SELECT trip_request_id AS t, (SELECT id FROM packages WHERE plan_id = plans.id) AS pkg FROM plans WHERE id = ?",
	)
		.bind(planId)
		.first<{ t: string; pkg: string }>();
	// A re-check plan pointing at the first (plans.rechecked_from), as the cron makes.
	const recheckId = `plan-${crypto.randomUUID()}`;
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO plans (id, user_id, trip_request_id, status, result_json, rechecked_from)
			 VALUES (?, ?, ?, 'done', '{}', ?)`,
		).bind(recheckId, u.id, plan?.t, planId),
		env.DB.prepare(
			`INSERT INTO package_items (id, package_id, position, kind, title, provider, amount_minor,
			   currency, is_estimate, fetched_at, method)
			 VALUES (?, ?, 0, 'ticket', 'Seat', 'ticketmaster', 9000, 'CAD', 0, ?, 'live')`,
		).bind(crypto.randomUUID(), plan?.pkg, new Date().toISOString()),
		env.DB.prepare(
			`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, currency, last_checked_at)
			 VALUES (?, ?, ?, ?, 'CAD', ?)`,
		).bind(u.id, planId, plan?.t, recheckId, new Date().toISOString()),
		env.DB.prepare("INSERT INTO share_links (token, plan_id, user_id) VALUES (?, ?, ?)").bind(
			`tok-${crypto.randomUUID()}`,
			planId,
			u.id,
		),
		env.DB.prepare(
			`INSERT INTO price_alerts (id, user_id, trip_request_id, plan_id, old_total_minor, new_total_minor, currency)
			 VALUES (?, ?, ?, ?, 10000, 9000, 'CAD')`,
		).bind(crypto.randomUUID(), u.id, plan?.t, recheckId),
		env.DB.prepare(
			"INSERT INTO push_devices (id, user_id, platform, token) VALUES (?, ?, 'android', ?)",
		).bind(crypto.randomUUID(), u.id, `tok-${crypto.randomUUID()}`),
		env.DB.prepare("INSERT INTO push_throttle (user_id, room_key) VALUES (?, 'group:x')").bind(
			u.id,
		),
		env.DB.prepare("INSERT INTO notification_prefs (user_id, dm) VALUES (?, 0)").bind(u.id),
	]);
	await issueNativeCode(env.DB, u.id, "a".repeat(43));
	return planId;
}

/** Row counts of everything that belongs to `id`. */
async function footprint(id: string) {
	const plans = "SELECT id FROM plans WHERE user_id = ?";
	return {
		trip_requests: await n("trip_requests WHERE user_id = ?", id),
		plans: await n("plans WHERE user_id = ?", id),
		packages: await n(`packages WHERE plan_id IN (${plans})`, id),
		package_items: await n(
			`package_items WHERE package_id IN (SELECT id FROM packages WHERE plan_id IN (${plans}))`,
			id,
		),
		saved_trips: await n("saved_trips WHERE user_id = ?", id),
		share_links: await n("share_links WHERE user_id = ?", id),
		price_alerts: await n("price_alerts WHERE user_id = ?", id),
		push_devices: await n("push_devices WHERE user_id = ?", id),
		push_throttle: await n("push_throttle WHERE user_id = ?", id),
		notification_prefs: await n("notification_prefs WHERE user_id = ?", id),
		native_auth_codes: await n("native_auth_codes WHERE user_id = ?", id),
		group_members: await n("group_members WHERE user_id = ?", id),
		blocks: await n("blocks WHERE blocker_id = ? OR blocked_id = ?", id, id),
	};
}

interface World {
	a: TgUser;
	b: TgUser;
	c: TgUser;
	groupId: string;
	abConn: string;
	bcConn: string;
	aGroupReported: string;
	aGroupPlain: string;
	aDmReported: string;
	aDmPlain: string;
	bGroupMsg: string;
	bDmMsg: string;
}

/** a, b and c share a group; a-b and b-c are connected; everyone has data everywhere. */
async function world(): Promise<World> {
	const a = await tagalongUser({ old: true, ack: true });
	const b = await tagalongUser({ old: true, ack: true });
	const c = await tagalongUser({ old: true, ack: true });
	const { groupId } = await groupWith(a, b, c);
	const abConn = await connect(a, b);
	const bcConn = await connect(b, c);
	const aGroupReported = await send(`/groups/${groupId}/messages`, a.cookie, "a group reported");
	const aGroupPlain = await send(`/groups/${groupId}/messages`, a.cookie, "a group plain");
	const aDmReported = await send(`/dms/${abConn}/messages`, a.cookie, "a dm reported");
	const aDmPlain = await send(`/dms/${abConn}/messages`, a.cookie, "a dm plain");
	const bGroupMsg = await send(`/groups/${groupId}/messages`, b.cookie, "b group text");
	const bDmMsg = await send(`/dms/${bcConn}/messages`, b.cookie, "b dm text");
	for (const id of [aGroupReported, aDmReported])
		expect(
			(
				await postJson(
					"/reports",
					{ target_type: "message", target_id: id, reason: "spam" },
					b.cookie,
				)
			).status,
		).toBe(201);
	expect(
		(
			await postJson(
				"/reports",
				{ target_type: "user", target_id: a.id, reason: "other" },
				c.cookie,
			)
		).status,
	).toBe(201);
	expect(
		(
			await postJson(
				"/reports",
				{ target_type: "user", target_id: c.id, reason: "other" },
				a.cookie,
			)
		).status,
	).toBe(201);
	// Blocks both ways for a, and one between c and b (not involving a) that must survive.
	await postJson("/blocks", { user_id: c.id }, a.cookie);
	await env.DB.batch([
		env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)").bind(b.id, a.id),
		env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)").bind(c.id, b.id),
	]);
	await fillBudgetrip(a);
	await fillBudgetrip(b);
	return {
		a,
		b,
		c,
		groupId,
		abConn,
		bcConn,
		aGroupReported,
		aGroupPlain,
		aDmReported,
		aDmPlain,
		bGroupMsg,
		bDmMsg,
	};
}

const userRow = (id: string) =>
	env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();

// ---------------------------------------------------------------------------

describe("account deletion: data", () => {
	it("empties every table for the user, leaves another user's rows exactly as they were, and keeps FKs intact", async () => {
		const w = await world();
		const before = await footprint(w.a.id);
		for (const [table, count] of Object.entries(before))
			expect(count, `fixture: a has ${table}`).toBeGreaterThan(0);
		const bBefore = await footprint(w.b.id);
		const bUserBefore = await userRow(w.b.id);
		const cUserBefore = await userRow(w.c.id);

		const res = await del(w.a.cookie);
		expect(res.status).toBe(200);

		const after = await footprint(w.a.id);
		for (const [table, count] of Object.entries(after)) expect(count, table).toBe(0);
		// b lost only the block that pointed at a (blocks either way are a's data).
		expect(await footprint(w.b.id)).toEqual({ ...bBefore, blocks: bBefore.blocks - 1 });
		expect(await n("blocks WHERE blocker_id = ? AND blocked_id = ?", w.c.id, w.b.id)).toBe(1);
		expect(await userRow(w.b.id)).toEqual(bUserBefore);
		expect(await userRow(w.c.id)).toEqual(cUserBefore);
		// b and c are still in the group; their connection is as it was.
		expect(await n("group_members WHERE group_id = ?", w.groupId)).toBe(2);
		expect(await n("connections WHERE id = ? AND status = 'accepted'", w.bcConn)).toBe(1);
		expect(await n("connections WHERE id = ? AND status = 'closed'", w.abConn)).toBe(1);

		const fk = await env.DB.prepare("PRAGMA foreign_key_check").all();
		expect(fk.results).toEqual([]);
	});

	it("scrubs the user's messages except reported ones, never touches others' messages, and keeps reports", async () => {
		const w = await world();
		await del(w.a.cookie);
		const msgs = await env.DB.prepare(
			"SELECT id, body, deleted_at, deleted_by, user_id FROM messages WHERE id IN (?, ?, ?, ?, ?, ?)",
		)
			.bind(w.aGroupReported, w.aGroupPlain, w.aDmReported, w.aDmPlain, w.bGroupMsg, w.bDmMsg)
			.all<{ id: string; body: string; deleted_at: string | null; deleted_by: string | null }>();
		const m = Object.fromEntries(msgs.results.map((r) => [r.id, r]));
		expect(m[w.aGroupReported]).toMatchObject({ body: "a group reported", deleted_by: "author" });
		expect(m[w.aDmReported]).toMatchObject({ body: "a dm reported", deleted_by: "author" });
		expect(m[w.aGroupPlain]).toMatchObject({ body: DELETED_MESSAGE_BODY, deleted_by: "author" });
		expect(m[w.aDmPlain]).toMatchObject({ body: DELETED_MESSAGE_BODY, deleted_by: "author" });
		for (const id of [w.aGroupReported, w.aGroupPlain, w.aDmReported, w.aDmPlain])
			expect(m[id]?.deleted_at, id).toBeTruthy();
		expect(m[w.bGroupMsg]).toMatchObject({ body: "b group text", deleted_at: null });
		expect(m[w.bDmMsg]).toMatchObject({ body: "b dm text", deleted_at: null });
		// Every report survives: on a's messages, about a, and by a.
		expect(await n("reports WHERE target_id IN (?, ?)", w.aGroupReported, w.aDmReported)).toBe(2);
		expect(await n("reports WHERE target_type = 'user' AND target_id = ?", w.a.id)).toBe(1);
		expect(await n("reports WHERE reporter_id = ?", w.a.id)).toBe(1);
	});

	it("a message already deleted by a moderator keeps deleted_by='moderator' and its time", async () => {
		const a = await tagalongUser({ old: true, ack: true });
		const b = await tagalongUser({ old: true, ack: true });
		const { groupId } = await groupWith(a, b);
		const id = await send(`/groups/${groupId}/messages`, a.cookie, "removed by mod");
		await env.DB.prepare(
			"UPDATE messages SET deleted_at = '2026-01-02T00:00:00.000Z', deleted_by = 'moderator' WHERE id = ?",
		)
			.bind(id)
			.run();
		await del(a.cookie);
		const row = await env.DB.prepare(
			"SELECT deleted_at, deleted_by, body FROM messages WHERE id = ?",
		)
			.bind(id)
			.first();
		expect(row).toEqual({
			deleted_at: "2026-01-02T00:00:00.000Z",
			deleted_by: "moderator",
			body: DELETED_MESSAGE_BODY,
		});
	});

	it("the tombstone keeps only id, created_at, deleted_at and the suspension marker", async () => {
		const a = await tagalongUser({ old: true, ack: true });
		await env.DB.prepare(
			`UPDATE users SET tagalong_suspended_at = '2026-03-03T00:00:00.000Z',
			   tagalong_trusted_at = '2026-01-01T00:00:00.000Z', age_confirmed_at = '2026-01-01T00:00:00.000Z',
			   home_currency = 'CAD', apple_sub = ?, apple_refresh_token_enc = 'x.y' WHERE id = ?`,
		)
			.bind(uniqueSub(), a.id)
			.run();
		const before = await userRow(a.id);
		expect((await del(a.cookie)).status).toBe(200);
		const row = await userRow(a.id);
		expect(row).toMatchObject({
			id: a.id,
			created_at: before?.created_at,
			google_sub: `deleted:${a.id}`,
			email: "",
			display_name: DELETED_USER_NAME,
			home_city: null,
			home_lat: null,
			home_lng: null,
			home_currency: null,
			birthdate_verified_18: 0,
			age_confirmed_at: null,
			tagalong_opt_in_at: null,
			tagalong_name: null,
			tagalong_city: null,
			tagalong_safety_ack_at: null,
			tagalong_trusted_at: null,
			tagalong_suspended_at: "2026-03-03T00:00:00.000Z",
			apple_sub: null,
			apple_refresh_token_enc: null,
		});
		expect(typeof row?.deleted_at).toBe("string");
		// No column still holds anything personal from before.
		for (const [k, v] of Object.entries(before ?? {})) {
			if (["id", "created_at", "tagalong_suspended_at"].includes(k)) continue;
			if (typeof v === "string" && v.length > 3) expect(row?.[k], k).not.toBe(v);
		}
	});
});

describe("account deletion: credentials", () => {
	it("cookie, bearer, chat ticket and a pending native code are all dead afterwards", async () => {
		const a = await tagalongUser({ old: true, ack: true });
		const b = await tagalongUser({ old: true, ack: true });
		const { groupId } = await groupWith(a, b);
		const bearer = (await issueBearer(env, a.id)).token;
		const ticketRes = await call("/chat/ticket", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "capacitor://localhost",
				Authorization: `Bearer ${bearer}`,
			},
			body: JSON.stringify({ kind: "group", id: groupId }),
		});
		expect(ticketRes.status).toBe(200);
		const { ticket } = await ticketRes.json<{ ticket: string }>();
		const pk = await pkcePair();
		const code = await issueNativeCode(env.DB, a.id, pk.challenge);

		expect((await del(a.cookie)).status).toBe(200);

		expect((await call("/me", { cookie: a.cookie })).status).toBe(401);
		expect((await call("/me", { headers: { Authorization: `Bearer ${bearer}` } })).status).toBe(
			401,
		);
		expect((await call("/trips", { cookie: a.cookie })).status).toBe(401);
		expect(
			(await postJson(`/groups/${groupId}/messages`, { body: "ghost" }, a.cookie)).status,
		).toBe(401);
		const ws = await call(`/chat/group/${groupId}/ws?ticket=${encodeURIComponent(ticket)}`, {
			headers: { Upgrade: "websocket", Origin: "capacitor://localhost" },
		});
		expect(ws.status).toBe(401);
		expect(ws.webSocket).toBeFalsy();
		const ex = await call("/auth/native/exchange", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "capacitor://localhost",
				"CF-Connecting-IP": "203.0.113.77",
			},
			body: JSON.stringify({ code, code_verifier: pk.verifier }),
		});
		expect(ex.status).toBe(400);
		// A bearer-authenticated second delete is refused too.
		const again = await call("/me/delete", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "capacitor://localhost",
				Authorization: `Bearer ${bearer}`,
			},
			body: JSON.stringify({ confirm: "DELETE" }),
		});
		expect(again.status).toBe(401);
	});

	it("the native app can delete with its bearer (no cookie, no web origin)", async () => {
		const u = await signedInUser();
		const bearer = (await issueBearer(env, u.id)).token;
		const res = await call("/me/delete", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "capacitor://localhost",
				Authorization: `Bearer ${bearer}`,
			},
			body: JSON.stringify({ confirm: "DELETE" }),
		});
		expect(res.status).toBe(200);
		expect(await n("users WHERE id = ? AND deleted_at IS NOT NULL", u.id)).toBe(1);
	});

	it("is idempotent: a second, concurrent request leaves the same tombstone and deleted_at", async () => {
		const u = await signedInUser();
		await fillBudgetrip(u);
		const results = await Promise.all([del(u.cookie), del(u.cookie)]);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses.every((s) => s === 200 || s === 401)).toBe(true);
		expect(statuses).toContain(200);
		const first = (await userRow(u.id))?.deleted_at;
		expect(first).toBeTruthy();
		// Re-running the request (e.g. a client retry) changes nothing.
		expect((await del(u.cookie)).status).toBe(401);
		expect((await userRow(u.id))?.deleted_at).toBe(first);
		expect(Object.values(await footprint(u.id)).every((x) => x === 0)).toBe(true);
		expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
	});
});

describe("account deletion: how others see the tombstone", () => {
	it("group members, chat history, connections, blocks list and the moderation queue never show the old identity", async () => {
		const w = await world();
		const oldName = w.a.name;
		await del(w.a.cookie);

		const group = await (await call(`/groups/${w.groupId}`, { cookie: w.b.cookie })).json<any>();
		expect(JSON.stringify(group)).not.toContain(oldName);
		expect(group.members.some((m: any) => m.user_id === w.a.id)).toBe(false);

		const hist = await (
			await call(`/groups/${w.groupId}/messages`, { cookie: w.b.cookie })
		).json<any>();
		expect(hist.messages.some((m: any) => m.user_id === w.a.id)).toBe(false);
		expect(JSON.stringify(hist)).not.toContain(oldName);
		expect(JSON.stringify(hist)).not.toContain("a group");

		const dm = await call(`/dms/${w.abConn}/messages`, { cookie: w.b.cookie });
		if (dm.status === 200) {
			const body = await dm.json<any>();
			expect(JSON.stringify(body)).not.toContain(oldName);
			expect(JSON.stringify(body)).not.toContain("a dm plain");
		} else expect([403, 404]).toContain(dm.status);

		const conns = await (await call("/connections", { cookie: w.b.cookie })).json<any>();
		const ab = conns.connections.find((x: any) => x.id === w.abConn);
		expect(ab?.other_name).toBe(DELETED_USER_NAME);
		expect(ab?.status).toBe("closed");
		expect(ab?.other_city ?? "").toBe(""); // the old city is gone too
		expect(JSON.stringify(conns)).not.toContain(oldName);

		const blocks = await (await call("/blocks", { cookie: w.b.cookie })).json<any>();
		expect(blocks.blocks.some((x: any) => x.user_id === w.a.id)).toBe(false);

		const mod = await signedInUser({ id: MODERATOR_ID });
		const queue = (
			await (await call("/mod/reports?status=open", { cookie: mod.cookie })).json<any>()
		).reports as any[];
		const onMsg = queue.find((r) => r.target_id === w.aGroupReported);
		expect(onMsg.message).toMatchObject({
			body: "a group reported",
			author_id: w.a.id,
			author_name: DELETED_USER_NAME,
		});
		expect(onMsg.target_user).toMatchObject({
			user_id: w.a.id,
			name: DELETED_USER_NAME,
			city: null,
		});
		const aboutA = queue.find((r) => r.target_type === "user" && r.target_id === w.a.id);
		expect(aboutA.target_user.name).toBe(DELETED_USER_NAME);
		const byA = queue.find((r) => r.reporter.user_id === w.a.id);
		expect(byA.reporter.name).toBe(DELETED_USER_NAME);
		expect(JSON.stringify(queue)).not.toContain(oldName);
	});

	it("a leftover block row naming the tombstone is listed as Deleted user; a new block on it is a no-op", async () => {
		const a = await tagalongUser({ old: true, ack: true });
		const b = await tagalongUser({ old: true, ack: true });
		await del(a.cookie);
		await env.DB.prepare("INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)")
			.bind(b.id, a.id)
			.run();
		const list = await (await call("/blocks", { cookie: b.cookie })).json<any>();
		expect(list.blocks.find((x: any) => x.user_id === a.id)?.name).toBe(DELETED_USER_NAME);
		await env.DB.prepare("DELETE FROM blocks WHERE blocker_id = ?").bind(b.id).run();
		const c = await signedInUser();
		await del(c.cookie);
		await postJson("/blocks", { user_id: c.id }, b.cookie);
		expect(await n("blocks WHERE blocker_id = ? AND blocked_id = ?", b.id, c.id)).toBe(0);
	});

	it("the tombstone is never a push recipient, even if a device or membership row survived", async () => {
		const a = await tagalongUser({ old: true, ack: true });
		const b = await tagalongUser({ old: true, ack: true });
		const c = await tagalongUser({ old: true, ack: true });
		const { groupId } = await groupWith(a, b, c);
		await del(a.cookie);
		// Simulate stale rows (a race, or a bug elsewhere) and every Tagalong gate passing.
		const aTok = `tok-a-${crypto.randomUUID()}`;
		const cTok = `tok-c-${crypto.randomUUID()}`;
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO group_members (group_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
			).bind(groupId, a.id),
			env.DB.prepare(
				`UPDATE users SET tagalong_opt_in_at = '2026-01-01T00:00:00.000Z', birthdate_verified_18 = 1,
				   tagalong_name = 'Ghost' WHERE id = ?`,
			).bind(a.id),
			...[
				[a.id, aTok],
				[c.id, cTok],
			].flatMap(([id, t]) => [
				env.DB.prepare(
					"INSERT INTO push_devices (id, user_id, platform, token) VALUES (?, ?, 'android', ?)",
				).bind(crypto.randomUUID(), id, t),
				env.DB.prepare(
					`INSERT INTO notification_prefs (user_id, group_message, price_drop) VALUES (?, 1, 1)
					 ON CONFLICT (user_id) DO UPDATE SET group_message = 1, price_drop = 1`,
				).bind(id),
			]),
		]);
		const sent: string[] = [];
		mockFetch(
			(url) =>
				url.host === "oauth2.googleapis.com"
					? json({ access_token: "ya29.x", expires_in: 3600 })
					: undefined,
			(url, init) => {
				if (url.host !== "fcm.googleapis.com") return undefined;
				sent.push((JSON.parse(String(init?.body)) as { message: { token: string } }).message.token);
				return json({ name: "projects/x/messages/1" });
			},
		);
		await dispatchPush(fcmEnv, { kind: "group_message", authorId: b.id, groupId });
		expect(sent).toContain(cTok); // the control: pushes do go out
		expect(sent).not.toContain(aTok);

		// A price alert for the tombstone (non-Tagalong path: only deleted_at stops it).
		const planId = await makeEventPlan(a.id, await makeEvent());
		const alertId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO price_alerts (id, user_id, trip_request_id, plan_id, old_total_minor, new_total_minor, currency)
			 SELECT ?, user_id, trip_request_id, id, 20000, 10000, 'CAD' FROM plans WHERE id = ?`,
		)
			.bind(alertId, planId)
			.run();
		sent.length = 0;
		await dispatchPush(fcmEnv, { kind: "price_drop", alertId });
		expect(sent).toEqual([]);
	});

	it("the scheduled price check skips a tombstone's saved trip", async () => {
		const a = await signedInUser();
		await del(a.cookie);
		const planId = await makeEventPlan(a.id, await makeEvent());
		await env.DB.prepare(
			`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, currency, best_total_minor)
			 SELECT user_id, id, trip_request_id, id, 'CAD', 50000 FROM plans WHERE id = ?`,
		)
			.bind(planId)
			.run();
		// Everything else in this file is "just checked", so only a's trip could be due.
		await env.DB.prepare("UPDATE saved_trips SET last_checked_at = ? WHERE user_id <> ?")
			.bind(new Date().toISOString(), a.id)
			.run();
		const spy = mockFetch(() => undefined);
		const r = await checkSavedTrips(env);
		expect(r).toEqual({ checked: 0, alerts: 0 });
		expect(spy.calls).toHaveLength(0);
		const row = await env.DB.prepare("SELECT last_checked_at FROM saved_trips WHERE user_id = ?")
			.bind(a.id)
			.first<{ last_checked_at: string | null }>();
		expect(row?.last_checked_at).toBeNull();
		expect(await n("price_alerts WHERE user_id = ?", a.id)).toBe(0);
	});
});

describe("account deletion: Apple revocation", () => {
	const deleteWithApple = (cookie: string) =>
		callWith(kit.appleEnv, "/me/delete", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: WEB, Cookie: cookie },
			body: JSON.stringify({ confirm: "DELETE" }),
		});

	const withAppleToken = async (rt: string) => {
		const u = await signedInUser();
		await env.DB.prepare("UPDATE users SET apple_refresh_token_enc = ? WHERE id = ?")
			.bind(await encryptRefreshToken(env, rt), u.id)
			.run();
		return u;
	};

	it("revokes with the decrypted token and a valid ES256 client secret, before anything is deleted", async () => {
		const u = await withAppleToken("rt-plain-123");
		const seen: { form: URLSearchParams; deletedAt: unknown }[] = [];
		mockFetch((url, init) => {
			if (url.href !== `${ISS}/auth/revoke`) return undefined;
			return (async () => {
				const row = await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?")
					.bind(u.id)
					.first<{ deleted_at: unknown }>();
				seen.push({
					form: new URLSearchParams(String(init?.body ?? "")),
					deletedAt: row?.deleted_at,
				});
				expect(new Headers(init?.headers).get("Content-Type")).toBe(
					"application/x-www-form-urlencoded",
				);
				return new Response(null, { status: 200 });
			})();
		});
		expect((await deleteWithApple(u.cookie)).status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.deletedAt).toBeNull();
		const form = seen[0]?.form as URLSearchParams;
		expect(form.get("token")).toBe("rt-plain-123");
		expect(form.get("token_type_hint")).toBe("refresh_token");
		expect(form.get("client_id")).toBe(SERVICES_ID);
		await assertClientSecret(kit, form.get("client_secret") ?? "");
	});

	for (const [label, answer] of [
		["Apple says 400", () => new Response('{"error":"invalid_client"}', { status: 400 })],
		["Apple says 500", () => new Response("", { status: 500 })],
		[
			"the request throws",
			() => {
				throw new TypeError("network down");
			},
		],
	] as const) {
		it(`deletion proceeds when the revoke fails (${label}), and the token is never logged`, async () => {
			const u = await withAppleToken("rt-must-not-be-logged");
			const logs: unknown[] = [];
			for (const level of ["log", "warn", "error", "info"] as const)
				vi.spyOn(console, level).mockImplementation((...args) => {
					logs.push(args);
				});
			let calls = 0;
			mockFetch((url) => {
				if (url.href !== `${ISS}/auth/revoke`) return undefined;
				calls++;
				return answer();
			});
			const res = await deleteWithApple(u.cookie);
			expect(res.status).toBe(200);
			expect(calls).toBe(1);
			expect(await n("users WHERE id = ? AND deleted_at IS NOT NULL", u.id)).toBe(1);
			expect(JSON.stringify(logs)).not.toContain("rt-must-not-be-logged");
			expect(JSON.stringify(logs)).not.toContain(kit.pem.slice(40, 80));
		});
	}

	it("an undecryptable stored token (rotated secret) skips the revoke and still deletes", async () => {
		const u = await signedInUser();
		const other = { ...env, SESSION_SECRET: "rotated-secret-0123456789abcdef0123456789" } as Env;
		await env.DB.prepare("UPDATE users SET apple_refresh_token_enc = ? WHERE id = ?")
			.bind(await encryptRefreshToken(other, "rt"), u.id)
			.run();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const spy = mockFetch(() => undefined);
		expect((await deleteWithApple(u.cookie)).status).toBe(200);
		expect(spy.calls).toHaveLength(0);
		expect(await n("users WHERE id = ? AND deleted_at IS NOT NULL", u.id)).toBe(1);
	});

	it("a Google-only account makes no outbound call at all", async () => {
		const u = await signedInUser();
		const spy = mockFetch(() => undefined);
		expect((await deleteWithApple(u.cookie)).status).toBe(200);
		expect(spy.calls).toHaveLength(0);
	});
});

describe("account deletion: request guards", () => {
	it("needs a trusted origin and a JSON body", async () => {
		const u = await signedInUser();
		for (const origin of ["https://evil.example", "capacitor://localhost", "null", ""])
			expect((await del(u.cookie, { confirm: "DELETE" }, origin)).status, origin).toBe(403);
		const noOrigin = await call("/me/delete", {
			method: "POST",
			cookie: u.cookie,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirm: "DELETE" }),
		});
		expect(noOrigin.status).toBe(403);
		for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
			const res = await call("/me/delete", {
				method: "POST",
				cookie: u.cookie,
				headers: { "Content-Type": type, Origin: WEB },
				body: type.includes("urlencoded")
					? "confirm=DELETE"
					: JSON.stringify({ confirm: "DELETE" }),
			});
			expect(res.status, type).toBe(415);
		}
		expect((await call("/me/delete", { cookie: u.cookie })).status).toBe(404);
		expect((await call("/me", { cookie: u.cookie })).status).toBe(200);
	});

	it('needs exactly {confirm: "DELETE"}', async () => {
		// The rate limit (5 an hour) counts refused bodies too: a fresh user per 4 tries.
		let u = await signedInUser();
		let tries = 0;
		for (const body of [
			null,
			[],
			"DELETE",
			{ confirm: " DELETE" },
			{ confirm: "DELETE " },
			{ confirm: "Delete" },
			{ confirm: "DELETE\u200b" },
			{ confirm: true },
			{ confirm: ["DELETE"] },
			{ confirm: null },
		]) {
			if (++tries % 4 === 0) u = await signedInUser();
			const res = await del(u.cookie, body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(await n("users WHERE id = ? AND deleted_at IS NULL", u.id)).toBe(1);
		}
		const raw = await call("/me/delete", {
			method: "POST",
			cookie: u.cookie,
			headers: { "Content-Type": "application/json", Origin: WEB },
			body: "{not json",
		});
		expect(raw.status).toBe(400);
		expect(await n("users WHERE id = ? AND deleted_at IS NULL", u.id)).toBe(1);
	});

	it("is rate limited (5 an hour per user); a limited request deletes nothing", async () => {
		const u = await signedInUser();
		for (let i = 0; i < 5; i++) expect((await del(u.cookie, { confirm: "no" })).status).toBe(400);
		const limited = await del(u.cookie);
		expect(limited.status).toBe(429);
		expect(await n("users WHERE id = ? AND deleted_at IS NULL", u.id)).toBe(1);
		// Another user isn't affected.
		const other = await signedInUser();
		expect((await del(other.cookie)).status).toBe(200);
	});
});

describe("account deletion: signing up again", () => {
	it("the same Google identity gets a fresh, empty account", async () => {
		const sub = `1${Date.now()}${Math.floor(Math.random() * 1e6)}`;
		const id = `g-${crypto.randomUUID()}`;
		await env.DB.prepare(
			"INSERT INTO users (id, google_sub, email, display_name, birthdate_verified_18) VALUES (?, ?, ?, 'Gina', 1)",
		)
			.bind(id, sub, `${id}@example.com`)
			.run();
		const old = await signedInUser({ id });
		await fillBudgetrip(old);
		expect((await del(old.cookie)).status).toBe(200);

		const ip = { "CF-Connecting-IP": randomIp() };
		const start = await call("/auth/google/start", { headers: ip });
		const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
		const b64 = (o: unknown) =>
			btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		mockFetch((url) =>
			url.hostname === "oauth2.googleapis.com"
				? json({
						id_token: `${b64({ alg: "RS256" })}.${b64({
							iss: "https://accounts.google.com",
							aud: env.GOOGLE_CLIENT_ID,
							sub,
							exp: Math.floor(Date.now() / 1000) + 600,
							email: `${id}@example.com`,
							email_verified: true,
							name: "Gina Again",
						})}.sig`,
					})
				: undefined,
		);
		const cb = await call(`/auth/google/callback?state=${state}&code=x`, {
			cookie: cookieOf(start, "tg_oauth"),
			headers: ip,
		});
		expect(cb.status).toBe(302);
		const me = await (await call("/me", { cookie: cookieOf(cb, "tg_session") })).json<any>();
		expect(me.id).not.toBe(id);
		expect(me).toMatchObject({
			display_name: "Gina Again",
			birthdate_verified_18: false,
			sign_in_providers: ["google"],
		});
		expect(Object.values(await footprint(me.id)).every((x) => x === 0)).toBe(true);
		expect(await n("users WHERE google_sub = ?", sub)).toBe(1);
		expect((await userRow(id))?.google_sub).toBe(`deleted:${id}`);
	});

	it("the same Apple identity gets a fresh account through the real sign-in", async () => {
		const sub = uniqueSub();
		const signIn = async () => {
			const s = await startApple(kit.appleEnv);
			mockApple(kit, { sub }, () => s.nonce);
			const res = await postAppleCallback(kit.appleEnv, { state: s.state, code: "c" }, s.cookie);
			vi.restoreAllMocks();
			expect(res.status).toBe(303);
			return cookieOf(res, "tg_session");
		};
		const first = await signIn();
		const firstId = (await (await call("/me", { cookie: first })).json<any>()).id;
		mockFetch((url) =>
			url.href === `${ISS}/auth/revoke` ? new Response(null, { status: 200 }) : undefined,
		);
		const res = await callWith(kit.appleEnv, "/me/delete", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: WEB, Cookie: first },
			body: JSON.stringify({ confirm: "DELETE" }),
		});
		expect(res.status).toBe(200);
		vi.restoreAllMocks();

		const second = await signIn();
		const me = await (await call("/me", { cookie: second })).json<any>();
		expect(me.id).not.toBe(firstId);
		expect(me.sign_in_providers).toEqual(["apple"]);
		expect((await call("/me", { cookie: first })).status).toBe(401);
		const tomb = await userRow(firstId);
		expect(tomb).toMatchObject({ apple_sub: null, google_sub: `deleted:${firstId}` });
	});
});

describe("account deletion: a suspension survives signing up again", () => {
	/** A Google sign-in through the real callback; returns the session cookie. */
	async function googleSignIn(sub: string, email: string) {
		const ip = { "CF-Connecting-IP": randomIp() };
		const start = await call("/auth/google/start", { headers: ip });
		const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
		const b64 = (o: unknown) =>
			btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		mockFetch((url) =>
			url.hostname === "oauth2.googleapis.com"
				? json({
						id_token: `${b64({ alg: "RS256" })}.${b64({
							iss: "https://accounts.google.com",
							aud: env.GOOGLE_CLIENT_ID,
							sub,
							exp: Math.floor(Date.now() / 1000) + 600,
							email,
							email_verified: true,
						})}.sig`,
					})
				: undefined,
		);
		const cb = await call(`/auth/google/callback?state=${state}&code=x`, {
			cookie: cookieOf(start, "tg_oauth"),
			headers: ip,
		});
		vi.restoreAllMocks();
		expect(cb.status).toBe(302);
		return cookieOf(cb, "tg_session");
	}

	const suspendedAtOf = async (cookie: string) => {
		const me = await (await call("/me", { cookie })).json<{ id: string }>();
		return (
			await env.DB.prepare("SELECT tagalong_suspended_at AS s FROM users WHERE id = ?")
				.bind(me.id)
				.first<{ s: string | null }>()
		)?.s;
	};

	it("Google: a suspended user who deletes and signs up again starts suspended; only a keyed hash is kept", async () => {
		const sub = `9${Date.now()}${Math.floor(Math.random() * 1e6)}`;
		const first = await googleSignIn(sub, "susp@example.com");
		const id = (await (await call("/me", { cookie: first })).json<{ id: string }>()).id;
		await env.DB.prepare(
			"UPDATE users SET tagalong_suspended_at = '2026-05-05T00:00:00.000Z' WHERE id = ?",
		)
			.bind(id)
			.run();
		expect((await del(first)).status).toBe(200);
		const rows = await env.DB.prepare("SELECT * FROM suspended_identities WHERE id_hash = ?")
			.bind(await identityHash(env, "google", sub))
			.all<Record<string, unknown>>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0]?.suspended_at).toBe("2026-05-05T00:00:00.000Z");
		// No raw sub, email or name anywhere in the table.
		const all = JSON.stringify(
			(await env.DB.prepare("SELECT * FROM suspended_identities").all()).results,
		);
		expect(all).not.toContain(sub);
		expect(all).not.toContain("susp@example.com");

		const again = await googleSignIn(sub, "susp@example.com");
		expect(await suspendedAtOf(again)).toBe("2026-05-05T00:00:00.000Z");
	});

	it("Apple: same for an Apple ID", async () => {
		const sub = uniqueSub();
		const signIn = async () => {
			const s = await startApple(kit.appleEnv);
			mockApple(kit, { sub, refreshToken: null }, () => s.nonce);
			const res = await postAppleCallback(kit.appleEnv, { state: s.state, code: "c" }, s.cookie);
			vi.restoreAllMocks();
			expect(res.status).toBe(303);
			return cookieOf(res, "tg_session");
		};
		const first = await signIn();
		const id = (await (await call("/me", { cookie: first })).json<{ id: string }>()).id;
		await env.DB.prepare(
			"UPDATE users SET tagalong_suspended_at = '2026-06-06T00:00:00.000Z' WHERE id = ?",
		)
			.bind(id)
			.run();
		expect((await del(first)).status).toBe(200);
		const again = await signIn();
		expect(await suspendedAtOf(again)).toBe("2026-06-06T00:00:00.000Z");
	});

	it("an account that was never suspended leaves no identity hash, and comes back unsuspended", async () => {
		const sub = `8${Date.now()}${Math.floor(Math.random() * 1e6)}`;
		const first = await googleSignIn(sub, "fine@example.com");
		expect((await del(first)).status).toBe(200);
		expect(
			await n("suspended_identities WHERE id_hash = ?", await identityHash(env, "google", sub)),
		).toBe(0);
		const again = await googleSignIn(sub, "fine@example.com");
		expect(await suspendedAtOf(again)).toBeNull();
	});
});
