/**
 * Phase 5: the chat socket (GET /chat/:kind/:id/ws) and its fan-out.
 * Checks run in the Worker before the Durable Object; the DO only fans out.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../tagalong/limits.js";
import {
	call,
	connect,
	groupWith,
	openSocket,
	postJson,
	settle,
	signedInUser,
	tagalongUser,
	WEB,
} from "./helpers.js";

const upgrade = (path: string, cookie?: string, origin: string | null = WEB) =>
	call(path, {
		...(cookie ? { cookie } : {}),
		headers: { Upgrade: "websocket", ...(origin ? { Origin: origin } : {}) },
	});

afterEach(() => {
	vi.useRealTimers();
});

const code = async (res: Response) => (await res.json<{ error: { code: string } }>()).error.code;

describe("chat socket checks", () => {
	it("needs an upgrade header (426)", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const res = await call(`/chat/group/${groupId}/ws`, {
			cookie: a.cookie,
			headers: { Origin: WEB },
		});
		expect(res.status).toBe(426);
	});

	it("refuses a foreign or missing Origin (403 bad_origin), even with a valid session", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const evil = await upgrade(`/chat/group/${groupId}/ws`, a.cookie, "https://evil.example");
		expect(evil.status).toBe(403);
		expect(await code(evil)).toBe("bad_origin");
		const none = await upgrade(`/chat/group/${groupId}/ws`, a.cookie, null);
		expect(none.status).toBe(403);
		expect(await code(none)).toBe("bad_origin");
	});

	it("refuses no cookie (401)", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const res = await upgrade(`/chat/group/${groupId}/ws`);
		expect(res.status).toBe(401);
	});

	it("refuses under-18, not opted in, and suspended users (403)", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const minor = await signedInUser({ adult: false });
		const m = await upgrade(`/chat/group/${groupId}/ws`, minor.cookie);
		expect(m.status).toBe(403);
		expect(await code(m)).toBe("age_unconfirmed");
		const plain = await signedInUser();
		const p = await upgrade(`/chat/group/${groupId}/ws`, plain.cookie);
		expect(p.status).toBe(403);
		expect(await code(p)).toBe("tagalong_opt_in_required");
		await env.DB.prepare("UPDATE users SET tagalong_suspended_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), a.id)
			.run();
		const s = await upgrade(`/chat/group/${groupId}/ws`, a.cookie);
		expect(s.status).toBe(403);
		expect(await code(s)).toBe("tagalong_suspended");
	});

	it("is 404 for a non-member of the group, and for an unknown group", async () => {
		const a = await tagalongUser();
		const outsider = await tagalongUser();
		const { groupId } = await groupWith(a);
		expect((await upgrade(`/chat/group/${groupId}/ws`, outsider.cookie)).status).toBe(404);
		expect((await upgrade(`/chat/group/no-such-group/ws`, a.cookie)).status).toBe(404);
	});

	it("is 404 for a DM the user is not party to, or that is not accepted", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		const c = await tagalongUser({ ack: true });
		await groupWith(a, b, c);
		const pending = await postJson("/connections", { user_id: b.id }, a.cookie);
		const pendingId = (await pending.json<{ connection: { id: string } }>()).connection.id;
		expect((await upgrade(`/chat/dm/${pendingId}/ws`, a.cookie)).status).toBe(404);
		await postJson(`/connections/${pendingId}/accept`, {}, b.cookie);
		expect((await upgrade(`/chat/dm/${pendingId}/ws`, c.cookie)).status).toBe(404);
	});

	it("rate-limits upgrades per user (429)", async () => {
		// Pin Date inside one minute so the fixed window can't roll over mid-test.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 61_000);
		const a = await tagalongUser();
		// A group that does not exist: each attempt passes the limiter, then 404s.
		for (let i = 0; i < LIMITS.ws.perMinute; i++)
			expect((await upgrade(`/chat/group/nope/ws`, a.cookie)).status).toBe(404);
		expect((await upgrade(`/chat/group/nope/ws`, a.cookie)).status).toBe(429);
	});

	it("ignores a client-supplied X-Tg-User header", async () => {
		const a = await tagalongUser();
		const outsider = await tagalongUser();
		const { groupId } = await groupWith(a);
		const res = await call(`/chat/group/${groupId}/ws`, {
			cookie: outsider.cookie,
			headers: { Upgrade: "websocket", Origin: WEB, "X-Tg-User": a.id },
		});
		expect(res.status).toBe(404);
	});
});

describe("chat socket fan-out", () => {
	it("upgrades a member (101) and delivers a message sent over HTTP, with is_me per recipient", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		const sa = await openSocket(`/chat/group/${groupId}/ws`, a.cookie);
		const sb = await openSocket(`/chat/group/${groupId}/ws`, b.cookie);
		expect(sa.res.status).toBe(101);

		const sent = await postJson(
			`/groups/${groupId}/messages`,
			{ body: "Pre-game at 6?" },
			a.cookie,
		);
		expect(sent.status).toBe(201);
		const { message } = await sent.json<{ message: { id: string } }>();

		const [fb] = await sb.waitFor(1);
		expect(fb).toMatchObject({
			type: "message",
			message: { id: message.id, body: "Pre-game at 6?", user_id: a.id, is_me: false },
		});
		const [fa] = await sa.waitFor(1);
		expect(fa).toMatchObject({ type: "message", message: { id: message.id, is_me: true } });

		// A delete is fanned out too.
		expect((await postJson(`/messages/${message.id}/delete`, {}, a.cookie)).status).toBe(200);
		const frames = await sb.waitFor(2);
		expect(frames[1]).toEqual({ type: "deleted", id: message.id });
		sa.ws.close();
		sb.ws.close();
	});

	it("does not deliver a blocked (or blocking) sender's messages", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const c = await tagalongUser();
		const { groupId } = await groupWith(a, b, c);
		expect((await postJson("/blocks", { user_id: a.id }, b.cookie)).status).toBe(200);
		const sb = await openSocket(`/chat/group/${groupId}/ws`, b.cookie);
		const sc = await openSocket(`/chat/group/${groupId}/ws`, c.cookie);
		const sa = await openSocket(`/chat/group/${groupId}/ws`, a.cookie);

		// a (blocked by b) sends: c gets it, b does not.
		await postJson(`/groups/${groupId}/messages`, { body: "from a" }, a.cookie);
		await sc.waitFor(1);
		// b (the blocker) sends: c gets it, a does not.
		await postJson(`/groups/${groupId}/messages`, { body: "from b" }, b.cookie);
		await sc.waitFor(2);
		await settle();
		const bodies = (frames: unknown[]) =>
			frames.map((f) => (f as { message?: { body: string } }).message?.body);
		expect(bodies(sb.frames)).toEqual(["from b"]);
		expect(bodies(sa.frames)).toEqual(["from a"]);
		expect(bodies(sc.frames)).toEqual(["from a", "from b"]);
		for (const s of [sa, sb, sc]) s.ws.close();
	});

	it("closes the socket with 4001 when the member leaves the group", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		const sa = await openSocket(`/chat/group/${groupId}/ws`, a.cookie);
		const sb = await openSocket(`/chat/group/${groupId}/ws`, b.cookie);
		expect((await postJson(`/groups/${groupId}/leave`, {}, a.cookie)).status).toBe(200);
		expect(await sa.closed).toBe(4001);
		// b stays connected and still receives.
		await postJson(`/groups/${groupId}/messages`, { body: "still here" }, b.cookie);
		await sb.waitFor(1);
		// a can no longer reconnect.
		expect((await upgrade(`/chat/group/${groupId}/ws`, a.cookie)).status).toBe(404);
		sb.ws.close();
	});

	it("a socket whose user is no longer a member gets nothing and is closed 4001 on the next send", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		const sb = await openSocket(`/chat/group/${groupId}/ws`, b.cookie);
		// Membership removed without a kick (e.g. a kick that failed).
		await env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
			.bind(groupId, b.id)
			.run();
		await postJson(`/groups/${groupId}/messages`, { body: "members only" }, a.cookie);
		expect(await sb.closed).toBe(4001);
		expect(sb.frames).toEqual([]);
	});

	it("is receive-only: a client frame closes the socket with 1008; ping gets pong", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const sa = await openSocket(`/chat/group/${groupId}/ws`, a.cookie);
		sa.ws.send("ping");
		expect(await sa.waitFor(1)).toEqual(["pong"]);
		sa.ws.send(JSON.stringify({ type: "message", body: "via socket" }));
		expect(await sa.closed).toBe(1008);
		const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = ?")
			.bind(groupId)
			.first<{ n: number }>();
		expect(stored?.n).toBe(0);
	});

	it("delivers DM messages over the DM socket and kicks both sides on block", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const connId = await connect(a, b);
		const sa = await openSocket(`/chat/dm/${connId}/ws`, a.cookie);
		const sb = await openSocket(`/chat/dm/${connId}/ws`, b.cookie);
		await postJson(`/dms/${connId}/messages`, { body: "hi" }, a.cookie);
		const [f] = await sb.waitFor(1);
		expect(f).toMatchObject({ type: "message", message: { body: "hi", room_kind: "dm" } });
		expect((await postJson("/blocks", { user_id: a.id }, b.cookie)).status).toBe(200);
		expect(await sa.closed).toBe(4001);
		expect(await sb.closed).toBe(4001);
		expect((await upgrade(`/chat/dm/${connId}/ws`, a.cookie)).status).toBe(404);
	});
});
