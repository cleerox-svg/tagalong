/**
 * Phase 5: the moderation queue. Only ids in MODERATOR_USER_IDS may use it
 * (vitest.config.ts sets exactly one); an empty list fails closed.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
	call,
	connect,
	groupWith,
	joinGroup,
	MODERATOR_ID,
	openSocket,
	postJson,
	signedInUser,
	tagalongUser,
	type TgUser,
} from "./helpers.js";

const mutableEnv = env as unknown as Record<string, string | undefined>;
const configuredMods = mutableEnv.MODERATOR_USER_IDS;
afterEach(() => {
	mutableEnv.MODERATOR_USER_IDS = configuredMods;
});

const errCode = async (res: Response) => (await res.json<{ error: { code: string } }>()).error.code;

const moderator = () => signedInUser({ id: MODERATOR_ID });

const queue = async (cookie: string, status = "open") =>
	(await (await call(`/mod/reports?status=${status}`, { cookie })).json<any>()).reports as any[];

const reportOf = (reports: any[], targetId: string) =>
	reports.find((r) => r.target_id === targetId);

/** a posts in a group with b; b reports it. Returns the ids involved. */
async function reportedMessage(body = "buy followers") {
	const a = await tagalongUser();
	const b = await tagalongUser();
	const { groupId } = await groupWith(a, b);
	const { message } = await (
		await postJson(`/groups/${groupId}/messages`, { body }, a.cookie)
	).json<any>();
	const res = await postJson(
		"/reports",
		{ target_type: "message", target_id: message.id, reason: "spam", details: "bot" },
		b.cookie,
	);
	expect(res.status).toBe(201);
	return { a, b, groupId, messageId: message.id as string };
}

const resolve = (id: string, action: string, cookie: string) =>
	postJson(`/mod/reports/${id}/resolve`, { action }, cookie);

describe("access", () => {
	it("is 403 not_moderator for everyone else, 401 signed out", async () => {
		const u = await tagalongUser();
		for (const res of [
			await call("/mod/reports", { cookie: u.cookie }),
			await resolve("any", "dismiss", u.cookie),
			await postJson(`/mod/users/${u.id}/trust`, {}, u.cookie),
		]) {
			expect(res.status).toBe(403);
			expect(await errCode(res)).toBe("not_moderator");
		}
		expect((await call("/mod/reports")).status).toBe(401);
		const me = await (await call("/me", { cookie: u.cookie })).json<any>();
		expect(me.tagalong.trusted).toBe(false);
	});

	it("fails closed when the moderator list is empty", async () => {
		const mod = await moderator();
		expect((await call("/mod/reports", { cookie: mod.cookie })).status).toBe(200);
		mutableEnv.MODERATOR_USER_IDS = "";
		const res = await call("/mod/reports", { cookie: mod.cookie });
		expect(res.status).toBe(403);
		expect(await errCode(res)).toBe("not_moderator");
		mutableEnv.MODERATOR_USER_IDS = " , ";
		expect((await call("/mod/reports", { cookie: mod.cookie })).status).toBe(403);
	});

	it("rejects an unknown status filter (400)", async () => {
		const mod = await moderator();
		expect((await call("/mod/reports?status=all", { cookie: mod.cookie })).status).toBe(400);
	});
});

describe("the queue", () => {
	it("shows the reported message (even soft-deleted by its author), the author, reporter and reason", async () => {
		const mod = await moderator();
		const { a, b, groupId, messageId } = await reportedMessage("delete me quick");
		// The author deletes it after the report: the body stays for review.
		expect((await postJson(`/messages/${messageId}/delete`, {}, a.cookie)).status).toBe(200);
		const report = reportOf(await queue(mod.cookie), messageId);
		expect(report).toMatchObject({
			target_type: "message",
			reason: "spam",
			details: "bot",
			resolved_at: null,
			reporter: { user_id: b.id, name: b.name },
			message: {
				id: messageId,
				body: "delete me quick",
				room_kind: "group",
				room_id: groupId,
				author_id: a.id,
				author_name: a.name,
				deleted_by: "author",
			},
			target_user: { user_id: a.id, name: a.name, city: "Toronto", suspended: false },
		});
		expect(report.message.deleted_at).not.toBeNull();
	});

	it("dismiss resolves it; a second decision is 409 already_resolved", async () => {
		const mod = await moderator();
		const { messageId, groupId, b } = await reportedMessage();
		const report = reportOf(await queue(mod.cookie), messageId);
		const res = await resolve(report.id, "dismiss", mod.cookie);
		expect(res.status).toBe(200);
		expect((await res.json<any>()).report).toMatchObject({
			id: report.id,
			resolution: "dismissed",
			resolved_by: MODERATOR_ID,
		});
		expect(reportOf(await queue(mod.cookie), messageId)).toBeUndefined();
		expect(reportOf(await queue(mod.cookie, "resolved"), messageId)?.id).toBe(report.id);
		// The message is untouched.
		expect(
			(await (await call(`/groups/${groupId}/messages`, { cookie: b.cookie })).json<any>())
				.messages,
		).toHaveLength(1);

		const again = await resolve(report.id, "remove_message", mod.cookie);
		expect(again.status).toBe(409);
		expect(await errCode(again)).toBe("already_resolved");
		expect((await resolve("no-such-report", "dismiss", mod.cookie)).status).toBe(404);
		expect((await resolve(report.id, "ban_forever", mod.cookie)).status).toBe(400);
	});
});

describe("remove_message", () => {
	it("soft-deletes as moderator, hides it, broadcasts, and resolves every report on it", async () => {
		const mod = await moderator();
		const { a, b, groupId, messageId } = await reportedMessage();
		const c = await tagalongUser();
		await joinGroup(c, groupId);
		await postJson(
			"/reports",
			{ target_type: "message", target_id: messageId, reason: "other" },
			c.cookie,
		);

		const socket = await openSocket(`/chat/group/${groupId}/ws`, b.cookie);
		const reports = (await queue(mod.cookie)).filter((r) => r.target_id === messageId);
		expect(reports).toHaveLength(2);
		const res = await resolve(reports[0].id, "remove_message", mod.cookie);
		expect(res.status).toBe(200);
		expect((await res.json<any>()).report.resolution).toBe("message_removed");

		const row = await env.DB.prepare("SELECT body, deleted_by FROM messages WHERE id = ?")
			.bind(messageId)
			.first();
		expect(row).toEqual({ body: "buy followers", deleted_by: "moderator" });
		for (const u of [a, b, c]) {
			const page = await (
				await call(`/groups/${groupId}/messages`, { cookie: u.cookie })
			).json<any>();
			expect(page.messages).toEqual([]);
		}
		const [frame] = await socket.waitFor(1);
		expect(frame).toEqual({ type: "deleted", id: messageId });
		socket.ws.close();
		expect((await queue(mod.cookie)).filter((r) => r.target_id === messageId)).toEqual([]);
		const resolved = (await queue(mod.cookie, "resolved")).filter((r) => r.target_id === messageId);
		expect(resolved.map((r) => r.resolution)).toEqual(["message_removed", "message_removed"]);
	});

	it("keeps deleted_by='author' when the author had already deleted it", async () => {
		const mod = await moderator();
		const { a, messageId } = await reportedMessage();
		await postJson(`/messages/${messageId}/delete`, {}, a.cookie);
		const report = reportOf(await queue(mod.cookie), messageId);
		expect((await resolve(report.id, "remove_message", mod.cookie)).status).toBe(200);
		const row = await env.DB.prepare("SELECT deleted_by, deleted_at FROM messages WHERE id = ?")
			.bind(messageId)
			.first<{ deleted_by: string; deleted_at: string | null }>();
		expect(row?.deleted_by).toBe("author");
		expect(row?.deleted_at).not.toBeNull();
	});

	it("is 400 for a user report", async () => {
		const mod = await moderator();
		const a = await tagalongUser();
		const b = await tagalongUser();
		await groupWith(a, b);
		await postJson("/reports", { target_type: "user", target_id: a.id, reason: "spam" }, b.cookie);
		const report = reportOf(await queue(mod.cookie), a.id);
		const res = await resolve(report.id, "remove_message", mod.cookie);
		expect(res.status).toBe(400);
		expect(reportOf(await queue(mod.cookie), a.id)).toBeDefined();
	});
});

describe("suspend_user", () => {
	async function suspended() {
		const mod = await moderator();
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		const { groupId } = await groupWith(a, b);
		const connId = await connect(a, b);
		await postJson(
			"/reports",
			{ target_type: "user", target_id: a.id, reason: "safety" },
			b.cookie,
		);
		return { mod, a, b, groupId, connId, report: reportOf(await queue(mod.cookie), a.id) };
	}

	it("locks the user out of Tagalong (403 tagalong_suspended) and removes memberships", async () => {
		const { mod, a, b, groupId, connId, report } = await suspended();
		const groupSocket = await openSocket(`/chat/group/${groupId}/ws`, a.cookie);
		const dmSocket = await openSocket(`/chat/dm/${connId}/ws`, b.cookie);

		const res = await resolve(report.id, "suspend_user", mod.cookie);
		expect(res.status).toBe(200);
		expect((await res.json<any>()).report).toMatchObject({
			resolution: "user_suspended",
			target_user: { user_id: a.id, suspended: true },
		});

		for (const r of [
			await call("/connections", { cookie: a.cookie }),
			await call(`/groups/${groupId}`, { cookie: a.cookie }),
			await postJson(`/groups/${groupId}/messages`, { body: "still here?" }, a.cookie),
			await postJson(
				"/tagalong/opt-in",
				{ confirm: true, name: "Again", city: "Ottawa" },
				a.cookie,
			),
		]) {
			expect(r.status).toBe(403);
			expect(await errCode(r)).toBe("tagalong_suspended");
		}
		const me = await (await call("/me", { cookie: a.cookie })).json<any>();
		expect(me.tagalong.suspended).toBe(true);

		const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?")
			.bind(a.id)
			.first<{ n: number }>();
		expect(n?.n).toBe(0);
		const conn = await env.DB.prepare("SELECT status FROM connections WHERE id = ?")
			.bind(connId)
			.first<{ status: string }>();
		expect(conn?.status).toBe("closed");

		// Others no longer see them.
		const detail = await (await call(`/groups/${groupId}`, { cookie: b.cookie })).json<any>();
		expect(detail.members.map((m: { user_id: string }) => m.user_id)).toEqual([b.id]);
		expect((await call(`/tagalong/users/${a.id}`, { cookie: b.cookie })).status).toBe(404);
		expect((await call(`/dms/${connId}/messages`, { cookie: b.cookie })).status).toBe(404);

		// Their sockets are closed.
		expect(await groupSocket.closed).toBe(4001);
		expect(await dmSocket.closed).toBe(4001);
	});

	it("also resolves other open reports about the same user", async () => {
		const { mod, a, b, groupId, report } = await suspended();
		const c = await tagalongUser();
		await joinGroup(c, groupId);
		expect(
			(
				await postJson(
					"/reports",
					{ target_type: "user", target_id: a.id, reason: "spam" },
					c.cookie,
				)
			).status,
		).toBe(201);
		await resolve(report.id, "suspend_user", mod.cookie);
		expect((await queue(mod.cookie)).filter((r) => r.target_id === a.id)).toEqual([]);
		const resolved = (await queue(mod.cookie, "resolved")).filter((r) => r.target_id === a.id);
		expect(resolved.map((r) => r.reporter.user_id).sort()).toEqual([b.id, c.id].sort());
	});

	it("also resolves open reports on the suspended user's messages", async () => {
		const { mod, a, b, groupId, report } = await suspended();
		const { message } = await (
			await postJson(`/groups/${groupId}/messages`, { body: "spammy" }, a.cookie)
		).json<any>();
		await postJson(
			"/reports",
			{ target_type: "message", target_id: message.id, reason: "spam" },
			b.cookie,
		);
		expect(reportOf(await queue(mod.cookie), message.id)).toBeDefined();
		await resolve(report.id, "suspend_user", mod.cookie);
		expect(reportOf(await queue(mod.cookie), message.id)).toBeUndefined();
		expect(reportOf(await queue(mod.cookie, "resolved"), message.id)?.resolution).toBe(
			"user_suspended",
		);
	});

	it("suspending from a message report suspends the author", async () => {
		const mod = await moderator();
		const { a, messageId } = await reportedMessage();
		const report = reportOf(await queue(mod.cookie), messageId);
		expect((await resolve(report.id, "suspend_user", mod.cookie)).status).toBe(200);
		expect((await call("/connections", { cookie: a.cookie })).status).toBe(403);
	});
});

describe("trust", () => {
	it("trusts a user (lifting new-account limits); unknown user is 404", async () => {
		const mod = await moderator();
		const u: TgUser = await tagalongUser();
		const res = await postJson(`/mod/users/${u.id}/trust`, {}, mod.cookie);
		expect(res.status).toBe(200);
		const me = await (await call("/me", { cookie: u.cookie })).json<any>();
		expect(me.tagalong.trusted).toBe(true);
		expect((await postJson(`/mod/users/no-such-user/trust`, {}, mod.cookie)).status).toBe(404);
	});
});
