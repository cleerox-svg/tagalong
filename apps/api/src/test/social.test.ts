/**
 * Phase 5: mutual connect, DMs, blocks (hidden both ways, everywhere) and
 * reports.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../tagalong/limits.js";
import {
	call,
	connect,
	groupWith,
	postJson,
	signedInUser,
	tagalongUser,
	type TgUser,
} from "./helpers.js";

afterEach(() => {
	vi.useRealTimers();
});

const errCode = async (res: Response) => (await res.json<{ error: { code: string } }>()).error.code;

const ask = async (from: TgUser, to: TgUser) => {
	const res = await postJson("/connections", { user_id: to.id }, from.cookie);
	return { res, body: res.status === 200 ? await res.json<any>() : null };
};

const memberIds = async (groupId: string, u: TgUser) =>
	(
		(await (await call(`/groups/${groupId}`, { cookie: u.cookie })).json<any>()).members as {
			user_id: string;
		}[]
	).map((m) => m.user_id);

const bodies = async (path: string, u: TgUser) =>
	((await (await call(path, { cookie: u.cookie })).json<any>()).messages as { body: string }[]).map(
		(m) => m.body,
	);

describe("connecting", () => {
	it("is refused before the safety note is acknowledged (409 safety_ack_required)", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const { res } = await ask(a, b);
		expect(res.status).toBe(409);
		expect(await errCode(res)).toBe("safety_ack_required");
		const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM connections WHERE requested_by = ?")
			.bind(a.id)
			.first<{ n: number }>();
		expect(n?.n).toBe(0);
	});

	it("accepting also needs the safety note", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser();
		await groupWith(a, b);
		const { body } = await ask(a, b);
		const res = await postJson(`/connections/${body.connection.id}/accept`, {}, b.cookie);
		expect(res.status).toBe(409);
		expect(await errCode(res)).toBe("safety_ack_required");
		await postJson("/tagalong/safety-ack", {}, b.cookie);
		expect((await postJson(`/connections/${body.connection.id}/accept`, {}, b.cookie)).status).toBe(
			200,
		);
	});

	it("needs a shared group (404 otherwise), and not oneself", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a);
		await groupWith(b);
		expect((await ask(a, b)).res.status).toBe(404);
		expect((await postJson("/connections", { user_id: a.id }, a.cookie)).status).toBe(400);
		expect((await postJson("/connections", { user_id: "no-such-user" }, a.cookie)).status).toBe(
			404,
		);
	});

	it("a request is pending until the other side accepts; asking back accepts it", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const first = await ask(a, b);
		expect(first.body.connection).toMatchObject({
			other_user_id: b.id,
			other_name: b.name,
			status: "pending",
			requested_by_me: true,
		});
		// Asking again changes nothing.
		expect((await ask(a, b)).body.connection.status).toBe("pending");
		// The requester can't accept their own request.
		const self = await postJson(`/connections/${first.body.connection.id}/accept`, {}, a.cookie);
		expect(self.status).toBe(409);
		expect(await errCode(self)).toBe("not_pending");

		const back = await ask(b, a);
		expect(back.body.connection).toMatchObject({
			id: first.body.connection.id,
			status: "accepted",
			requested_by_me: false,
		});
		const list = await (await call("/connections", { cookie: a.cookie })).json<any>();
		expect(list.connections).toEqual([
			expect.objectContaining({
				id: first.body.connection.id,
				status: "accepted",
				other_user_id: b.id,
			}),
		]);
	});

	it("decline, then accept is 409 not_pending; close twice is 409 not_open", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const { body } = await ask(a, b);
		const id = body.connection.id;
		expect((await postJson(`/connections/${id}/decline`, {}, b.cookie)).status).toBe(200);
		const late = await postJson(`/connections/${id}/accept`, {}, b.cookie);
		expect(late.status).toBe(409);
		expect(await errCode(late)).toBe("not_pending");
		// A declined request isn't re-sent by asking again.
		expect((await ask(a, b)).body.connection.status).toBe("declined");

		const c = await tagalongUser({ ack: true });
		await groupWith(a, c);
		const cid = await connect(a, c);
		expect((await postJson(`/connections/${cid}/close`, {}, c.cookie)).status).toBe(200);
		const again = await postJson(`/connections/${cid}/close`, {}, a.cookie);
		expect(again.status).toBe(409);
		expect(await errCode(again)).toBe("not_open");
	});

	it("after a close only the person who closed it can ask again", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const id = await connect(a, b);
		// b ends it: a (the original asker) can't re-send.
		expect((await postJson(`/connections/${id}/close`, {}, b.cookie)).status).toBe(200);
		const retry = await ask(a, b);
		expect(retry.res.status).toBe(200);
		expect(retry.body.connection).toMatchObject({ id, status: "closed" });
		// b, who closed it, may ask again; a then accepts.
		const again = await ask(b, a);
		expect(again.body.connection).toMatchObject({ id, status: "pending", requested_by_me: true });
		expect((await postJson(`/connections/${id}/accept`, {}, a.cookie)).status).toBe(200);

		// a ends it this time: b can't re-send, a can.
		expect((await postJson(`/connections/${id}/close`, {}, a.cookie)).status).toBe(200);
		expect((await ask(b, a)).body.connection.status).toBe("closed");
		expect((await ask(a, b)).body.connection).toMatchObject({
			status: "pending",
			requested_by_me: true,
		});
	});

	it("someone else's connection is 404 to accept, decline or close", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		const c = await tagalongUser({ ack: true });
		await groupWith(a, b, c);
		const { body } = await ask(a, b);
		for (const action of ["accept", "decline", "close"])
			expect(
				(await postJson(`/connections/${body.connection.id}/${action}`, {}, c.cookie)).status,
			).toBe(404);
	});

	it("a new account may send only a few requests a day (429)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 61_000);
		const a = await tagalongUser({ ack: true });
		const others: TgUser[] = [];
		for (let i = 0; i <= LIMITS.connect.new.perDay; i++) others.push(await tagalongUser());
		await groupWith(a, ...others);
		for (let i = 0; i < LIMITS.connect.new.perDay; i++)
			expect((await ask(a, others[i]!)).res.status).toBe(200);
		expect((await ask(a, others[LIMITS.connect.new.perDay]!)).res.status).toBe(429);
	});
});

describe("DMs", () => {
	it("are refused until the connection is mutual, then work both ways", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const { body } = await ask(a, b);
		const id = body.connection.id;
		for (const u of [a, b]) {
			expect((await call(`/dms/${id}/messages`, { cookie: u.cookie })).status).toBe(404);
			expect((await postJson(`/dms/${id}/messages`, { body: "hi" }, u.cookie)).status).toBe(404);
		}
		await postJson(`/connections/${id}/accept`, {}, b.cookie);
		const sent = await postJson(`/dms/${id}/messages`, { body: "hi" }, a.cookie);
		expect(sent.status).toBe(201);
		expect((await sent.json<any>()).message).toMatchObject({
			room_kind: "dm",
			room_id: id,
			body: "hi",
		});
		await postJson(`/dms/${id}/messages`, { body: "hello back" }, b.cookie);
		expect(await bodies(`/dms/${id}/messages`, a)).toEqual(["hi", "hello back"]);
	});

	it("user C cannot read or write A and B's DM", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		const c = await tagalongUser({ ack: true });
		await groupWith(a, b, c);
		const id = await connect(a, b);
		await postJson(`/dms/${id}/messages`, { body: "private" }, a.cookie);
		const read = await call(`/dms/${id}/messages`, { cookie: c.cookie });
		expect(read.status).toBe(404);
		expect(await read.text()).not.toContain("private");
		expect((await postJson(`/dms/${id}/messages`, { body: "intrude" }, c.cookie)).status).toBe(404);
		expect(await bodies(`/dms/${id}/messages`, b)).toEqual(["private"]);
	});

	it("are closed once either side closes the connection", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const id = await connect(a, b);
		await postJson(`/connections/${id}/close`, {}, a.cookie);
		expect((await call(`/dms/${id}/messages`, { cookie: b.cookie })).status).toBe(404);
		expect((await postJson(`/dms/${id}/messages`, { body: "?" }, b.cookie)).status).toBe(404);
	});

	it("the link rule applies to DMs from new accounts", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const id = await connect(a, b);
		const res = await postJson(`/dms/${id}/messages`, { body: "https://x.example" }, a.cookie);
		expect(res.status).toBe(400);
		expect(await errCode(res)).toBe("links_not_allowed");
	});
});

describe("blocking", () => {
	it("hides both people from each other in members, messages and profiles", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const c = await tagalongUser();
		const { groupId } = await groupWith(a, b, c);
		for (const u of [a, b, c])
			await postJson(`/groups/${groupId}/messages`, { body: `from ${u.name}` }, u.cookie);

		expect((await postJson("/blocks", { user_id: b.id }, a.cookie)).status).toBe(200);

		expect(await memberIds(groupId, a)).toEqual([a.id, c.id]);
		expect(await memberIds(groupId, b)).toEqual([b.id, c.id]);
		expect(await memberIds(groupId, c)).toEqual([a.id, b.id, c.id]);

		const path = `/groups/${groupId}/messages`;
		expect(await bodies(path, a)).toEqual([`from ${a.name}`, `from ${c.name}`]);
		expect(await bodies(path, b)).toEqual([`from ${b.name}`, `from ${c.name}`]);
		expect(await bodies(path, c)).toHaveLength(3);

		expect((await call(`/tagalong/users/${b.id}`, { cookie: a.cookie })).status).toBe(404);
		expect((await call(`/tagalong/users/${a.id}`, { cookie: b.cookie })).status).toBe(404);
		expect((await call(`/tagalong/users/${a.id}`, { cookie: c.cookie })).status).toBe(200);
	});

	it("refuses connecting either way, closes an existing connection and its DM", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const id = await connect(a, b);
		await postJson(`/dms/${id}/messages`, { body: "before" }, a.cookie);

		expect((await postJson("/blocks", { user_id: a.id }, b.cookie)).status).toBe(200);
		const row = await env.DB.prepare("SELECT status, closed_by FROM connections WHERE id = ?")
			.bind(id)
			.first<{ status: string; closed_by: string }>();
		expect(row).toEqual({ status: "closed", closed_by: b.id });
		for (const u of [a, b]) {
			expect((await call(`/dms/${id}/messages`, { cookie: u.cookie })).status).toBe(404);
			expect((await postJson(`/dms/${id}/messages`, { body: "x" }, u.cookie)).status).toBe(404);
			const list = await (await call("/connections", { cookie: u.cookie })).json<any>();
			expect(list.connections).toEqual([]);
		}
		expect((await ask(a, b)).res.status).toBe(404);
		expect((await ask(b, a)).res.status).toBe(404);
	});

	it("a pending request can't be accepted once either side blocks", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		await groupWith(a, b);
		const { body } = await ask(a, b);
		await postJson("/blocks", { user_id: b.id }, a.cookie);
		expect((await postJson(`/connections/${body.connection.id}/accept`, {}, b.cookie)).status).toBe(
			404,
		);
	});

	it("GET /blocks lists only whom I blocked; unblocking restores visibility", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		await postJson("/blocks", { user_id: b.id }, a.cookie);
		const mine = await (await call("/blocks", { cookie: a.cookie })).json<any>();
		expect(mine.blocks).toEqual([expect.objectContaining({ user_id: b.id, name: b.name })]);
		const theirs = await (await call("/blocks", { cookie: b.cookie })).json<any>();
		expect(theirs.blocks).toEqual([]);
		// Only the blocker can lift it.
		await postJson(`/blocks/${a.id}/remove`, {}, b.cookie);
		expect(await memberIds(groupId, b)).toEqual([b.id]);
		await postJson(`/blocks/${b.id}/remove`, {}, a.cookie);
		expect(await memberIds(groupId, b)).toEqual([a.id, b.id]);
	});

	it("works without opt-in (adult only); refuses self and minors", async () => {
		const a = await signedInUser();
		const b = await signedInUser();
		expect((await postJson("/blocks", { user_id: b.id }, a.cookie)).status).toBe(200);
		expect((await postJson("/blocks", { user_id: b.id }, a.cookie)).status).toBe(200);
		expect((await postJson("/blocks", { user_id: a.id }, a.cookie)).status).toBe(400);
		const minor = await signedInUser({ adult: false });
		expect((await postJson("/blocks", { user_id: b.id }, minor.cookie)).status).toBe(403);
	});

	it("an unknown id answers the same 200 {blocked:true} (no existence oracle) and stores nothing", async () => {
		const a = await signedInUser();
		const res = await postJson("/blocks", { user_id: "no-such-user" }, a.cookie);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ blocked: true });
		const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ?")
			.bind(a.id)
			.first<{ n: number }>();
		expect(n?.n).toBe(0);
	});
});

describe("reports", () => {
	it("files a report on a visible message (201) and ignores a duplicate (200)", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		const { message } = await (
			await postJson(`/groups/${groupId}/messages`, { body: "rude" }, a.cookie)
		).json<any>();
		const input = {
			target_type: "message",
			target_id: message.id,
			reason: "harassment",
			details: "mean",
		};
		expect((await postJson("/reports", input, b.cookie)).status).toBe(201);
		expect((await postJson("/reports", { ...input, reason: "spam" }, b.cookie)).status).toBe(200);
		const rows = await env.DB.prepare(
			"SELECT reason, details FROM reports WHERE reporter_id = ? AND target_id = ?",
		)
			.bind(b.id, message.id)
			.all();
		expect(rows.results).toEqual([{ reason: "harassment", details: "mean" }]);
	});

	it("reports a user who shares a group (201); a stranger is 404", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const stranger = await tagalongUser();
		await groupWith(a, b);
		await groupWith(stranger);
		expect(
			(
				await postJson(
					"/reports",
					{ target_type: "user", target_id: a.id, reason: "safety" },
					b.cookie,
				)
			).status,
		).toBe(201);
		expect(
			(
				await postJson(
					"/reports",
					{ target_type: "user", target_id: stranger.id, reason: "safety" },
					b.cookie,
				)
			).status,
		).toBe(404);
		expect(
			(
				await postJson(
					"/reports",
					{ target_type: "user", target_id: b.id, reason: "safety" },
					b.cookie,
				)
			).status,
		).toBe(400);
	});

	it("can't report a message in a room you're not in, or your own", async () => {
		const a = await tagalongUser();
		const outsider = await tagalongUser();
		const { groupId } = await groupWith(a);
		const { message } = await (
			await postJson(`/groups/${groupId}/messages`, { body: "hi" }, a.cookie)
		).json<any>();
		const input = { target_type: "message", target_id: message.id, reason: "spam" };
		expect((await postJson("/reports", input, outsider.cookie)).status).toBe(404);
		expect((await postJson("/reports", input, a.cookie)).status).toBe(400);
	});

	it("refuses 'post' targets, unknown reasons and long details (400)", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		await groupWith(a, b);
		for (const input of [
			{ target_type: "post", target_id: "p1", reason: "spam" },
			{ target_type: "user", target_id: a.id, reason: "boring" },
			{ target_type: "user", target_id: a.id, reason: "spam", details: "x".repeat(1001) },
		])
			expect((await postJson("/reports", input, b.cookie)).status).toBe(400);
	});
});
