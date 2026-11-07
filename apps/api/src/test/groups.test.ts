/**
 * Phase 5: event groups (found from a plan the user owns), members, group
 * chat history, soft delete, the link rule and the new-account limits.
 */
import { env } from "cloudflare:test";
import { messageCursor } from "@tagalong/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../tagalong/limits.js";
import {
	call,
	groupWith,
	makeEvent,
	makeEventPlan,
	MODERATOR_ID,
	postJson,
	signedInUser,
	tagalongUser,
} from "./helpers.js";

afterEach(() => {
	vi.useRealTimers();
});

const errCode = async (res: Response) => (await res.json<{ error: { code: string } }>()).error.code;

/**
 * Pins Date to 1s into the next UTC minute so fixed-window counters (per
 * minute and per day) cannot roll over mid-test. Only Date is faked.
 */
function freezeClock() {
	const t = Math.floor(Date.now() / 60_000) * 60_000 + 61_000;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(t);
}

type Page = {
	messages: {
		id: string;
		body: string;
		user_id: string;
		is_me: boolean;
		seq: number;
		created_at: string;
	}[];
	has_more: boolean;
	before: string | null;
	after: string | null;
};

const page = async (groupId: string, cookie: string, query = "") =>
	(await call(`/groups/${groupId}/messages${query}`, { cookie })).json<Page>();

describe("finding a group from a plan", () => {
	it("shows a count for an event the user has a plan for (no opt-in needed)", async () => {
		const u = await signedInUser();
		const eventId = await makeEvent();
		await makeEventPlan(u.id, eventId);
		const res = await call(`/events/${eventId}/group`, { cookie: u.cookie });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ group_id: null, member_count: 0, joined: false });
	});

	it("also counts an event that is only on one of the plan's packages", async () => {
		const u = await tagalongUser();
		const eventId = await makeEvent();
		await makeEventPlan(u.id, eventId, "package");
		expect((await call(`/events/${eventId}/group`, { cookie: u.cookie })).status).toBe(200);
		expect((await postJson(`/events/${eventId}/group/join`, {}, u.cookie)).status).toBe(200);
	});

	it("is 404 for an event the user has no plan for, and joining it is refused", async () => {
		const owner = await tagalongUser();
		const other = await tagalongUser();
		const { eventId } = await groupWith(owner);
		expect((await call(`/events/${eventId}/group`, { cookie: other.cookie })).status).toBe(404);
		const join = await postJson(`/events/${eventId}/group/join`, {}, other.cookie);
		expect(join.status).toBe(404);
		expect(await errCode(join)).toBe("not_found");
		expect((await call(`/events/no-such-event/group`, { cookie: other.cookie })).status).toBe(404);
	});

	it("a share-link viewer cannot see or join the group for the shared plan", async () => {
		const owner = await tagalongUser();
		const viewer = await tagalongUser();
		const eventId = await makeEvent();
		const planId = await makeEventPlan(owner.id, eventId);
		const token = "S".repeat(43);
		await env.DB.prepare("INSERT INTO share_links (token, plan_id, user_id) VALUES (?, ?, ?)")
			.bind(token, planId, owner.id)
			.run();
		await postJson(`/events/${eventId}/group/join`, {}, owner.cookie);
		// The viewer opens the link while signed in...
		expect((await call(`/shared/${token}`, { cookie: viewer.cookie })).status).toBe(200);
		// ...which grants nothing on the event's group.
		expect((await call(`/events/${eventId}/group`, { cookie: viewer.cookie })).status).toBe(404);
		expect((await postJson(`/events/${eventId}/group/join`, {}, viewer.cookie)).status).toBe(404);
	});

	it("joining needs opt-in (403) even with a plan", async () => {
		const u = await signedInUser();
		const eventId = await makeEvent();
		await makeEventPlan(u.id, eventId);
		const res = await postJson(`/events/${eventId}/group/join`, {}, u.cookie);
		expect(res.status).toBe(403);
		expect(await errCode(res)).toBe("tagalong_opt_in_required");
	});

	it("makes exactly one group per event, and re-joining is idempotent", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const eventId = await makeEvent();
		await makeEventPlan(a.id, eventId);
		await makeEventPlan(b.id, eventId);
		const ja = await (await postJson(`/events/${eventId}/group/join`, {}, a.cookie)).json<any>();
		const jb = await (await postJson(`/events/${eventId}/group/join`, {}, b.cookie)).json<any>();
		expect(ja).toMatchObject({ member_count: 1, joined: true });
		expect(jb).toEqual({ group_id: ja.group_id, member_count: 2, joined: true });
		const again = await (await postJson(`/events/${eventId}/group/join`, {}, b.cookie)).json<any>();
		expect(again).toEqual(jb);
		const groups = await env.DB.prepare("SELECT COUNT(*) AS n FROM event_groups WHERE event_id = ?")
			.bind(eventId)
			.first<{ n: number }>();
		expect(groups?.n).toBe(1);
	});
});

describe("members and interest", () => {
	it("lists members with name, city and interest; interest can be changed or cleared", async () => {
		const a = await tagalongUser({ city: "Kingston" });
		const b = await tagalongUser();
		const eventId = await makeEvent("Raptors vs Celtics");
		await makeEventPlan(a.id, eventId);
		await makeEventPlan(b.id, eventId);
		const { group_id } = await (
			await postJson(`/events/${eventId}/group/join`, { interest: "  splitting a ride " }, a.cookie)
		).json<any>();
		await postJson(`/events/${eventId}/group/join`, {}, b.cookie);

		const detail = await (await call(`/groups/${group_id}`, { cookie: b.cookie })).json<any>();
		expect(detail.event).toMatchObject({
			id: eventId,
			name: "Raptors vs Celtics",
			city: "Toronto",
		});
		expect(detail.members).toEqual([
			{ user_id: a.id, name: a.name, city: "Kingston", interest: "splitting a ride", is_me: false },
			{ user_id: b.id, name: b.name, city: "Toronto", interest: null, is_me: true },
		]);

		expect(
			(await postJson(`/groups/${group_id}/interest`, { interest: "food" }, b.cookie)).status,
		).toBe(200);
		expect(
			(await postJson(`/groups/${group_id}/interest`, { interest: "x".repeat(141) }, b.cookie))
				.status,
		).toBe(400);
		await postJson(`/groups/${group_id}/interest`, { interest: "" }, a.cookie);
		const after = await (await call(`/groups/${group_id}`, { cookie: a.cookie })).json<any>();
		expect(after.members.map((m: any) => m.interest)).toEqual([null, "food"]);
	});

	it("re-joining without an interest keeps it; joining with too long an interest is 400", async () => {
		const a = await tagalongUser();
		const eventId = await makeEvent();
		await makeEventPlan(a.id, eventId);
		const { group_id } = await (
			await postJson(`/events/${eventId}/group/join`, { interest: "tailgate" }, a.cookie)
		).json<any>();
		await postJson(`/events/${eventId}/group/join`, {}, a.cookie);
		const detail = await (await call(`/groups/${group_id}`, { cookie: a.cookie })).json<any>();
		expect(detail.members[0].interest).toBe("tailgate");
		const long = await postJson(
			`/events/${eventId}/group/join`,
			{ interest: "x".repeat(141) },
			a.cookie,
		);
		expect(long.status).toBe(400);
	});
});

describe("interest text", () => {
	it("refuses links and e-mail addresses for everyone, even trusted accounts (400 invalid)", async () => {
		const a = await tagalongUser({ old: true });
		const eventId = await makeEvent();
		await makeEventPlan(a.id, eventId);
		for (const interest of ["see www.scam.example", "https://x.example", "bob@example.org"]) {
			const join = await postJson(`/events/${eventId}/group/join`, { interest }, a.cookie);
			expect(join.status, interest).toBe(400);
			expect(await errCode(join)).toBe("invalid");
		}
		const { group_id } = await (
			await postJson(`/events/${eventId}/group/join`, { interest: "rides" }, a.cookie)
		).json<any>();
		const set = await postJson(
			`/groups/${group_id}/interest`,
			{ interest: "cheapseats.com" },
			a.cookie,
		);
		expect(set.status).toBe(400);
		const { error } = await set.json<{ error: { code: string; message: string } }>();
		expect(error.code).toBe("invalid");
		expect(error.message).toBe("No links or e-mail addresses in an interest.");
		const detail = await (await call(`/groups/${group_id}`, { cookie: a.cookie })).json<any>();
		expect(detail.members[0].interest).toBe("rides");
	});
});

describe("non-members get 404", () => {
	it("on the group, its members, its messages, sending, leaving and interest", async () => {
		const a = await tagalongUser();
		const outsider = await tagalongUser();
		const { groupId } = await groupWith(a);
		await postJson(`/groups/${groupId}/messages`, { body: "members only" }, a.cookie);
		for (const res of [
			await call(`/groups/${groupId}`, { cookie: outsider.cookie }),
			await call(`/groups/${groupId}/messages`, { cookie: outsider.cookie }),
			await postJson(`/groups/${groupId}/messages`, { body: "let me in" }, outsider.cookie),
			await postJson(`/groups/${groupId}/leave`, {}, outsider.cookie),
			await postJson(`/groups/${groupId}/interest`, { interest: "x" }, outsider.cookie),
		]) {
			expect(res.status).toBe(404);
			expect(await errCode(res)).toBe("not_found");
		}
		const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id = ?")
			.bind(groupId)
			.first<{ n: number }>();
		expect(n?.n).toBe(1);
	});

	it("after leaving, the group and its chat are 404", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		expect((await postJson(`/groups/${groupId}/leave`, {}, a.cookie)).status).toBe(200);
		expect((await call(`/groups/${groupId}/messages`, { cookie: a.cookie })).status).toBe(404);
		expect((await postJson(`/groups/${groupId}/leave`, {}, a.cookie)).status).toBe(404);
		const detail = await (await call(`/groups/${groupId}`, { cookie: b.cookie })).json<any>();
		expect(detail.members.map((m: any) => m.user_id)).toEqual([b.id]);
	});
});

describe("group messages", () => {
	it("sends (201) and lists oldest first with is_me", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		const r1 = await postJson(`/groups/${groupId}/messages`, { body: "  first  " }, a.cookie);
		expect(r1.status).toBe(201);
		const { message } = await r1.json<any>();
		expect(message).toMatchObject({
			room_kind: "group",
			room_id: groupId,
			user_id: a.id,
			name: a.name,
			body: "first",
			is_me: true,
		});
		await postJson(`/groups/${groupId}/messages`, { body: "second" }, b.cookie);
		const p = await page(groupId, b.cookie);
		expect(p.messages.map((m) => [m.body, m.is_me])).toEqual([
			["first", false],
			["second", true],
		]);
		expect(p.has_more).toBe(false);
	});

	it("rejects an empty, blank, over-long or control/zero-width/bidi body (400)", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		for (const body of [
			"",
			"   ",
			"x".repeat(1001),
			5,
			null,
			"a\u0000b",
			"a\u200bb",
			"a\u202eb",
			"a\tb",
		])
			expect((await postJson(`/groups/${groupId}/messages`, { body }, a.cookie)).status).toBe(400);
		expect(
			(await postJson(`/groups/${groupId}/messages`, { body: "x".repeat(1000) }, a.cookie)).status,
		).toBe(201);
	});

	it("pages by seq with before/after cursors and has_more", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const total = 55;
		const base = Date.UTC(2026, 0, 1);
		await env.DB.batch(
			Array.from({ length: total }, (_, i) =>
				env.DB.prepare(
					`INSERT INTO messages (id, group_id, user_id, body, created_at, seq)
					 SELECT ?, ?, ?, ?, ?, COALESCE((SELECT MAX(seq) FROM messages), 0) + 1`,
				).bind(
					`m-${String(i).padStart(3, "0")}`,
					groupId,
					a.id,
					`msg ${i}`,
					new Date(base + i * 1000).toISOString(),
				),
			),
		);
		const latest = await page(groupId, a.cookie);
		expect(latest.messages).toHaveLength(50);
		expect(latest.messages[0]?.body).toBe("msg 5");
		expect(latest.messages.at(-1)?.body).toBe("msg 54");
		expect(latest.has_more).toBe(true);
		const seqs = latest.messages.map((m) => m.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(latest.before).toBe(messageCursor(latest.messages[0]!));
		expect(latest.after).toBe(messageCursor(latest.messages.at(-1)!));
		expect(latest.before).toMatch(/^\d+$/);

		const older = await page(groupId, a.cookie, `?before=${encodeURIComponent(latest.before!)}`);
		expect(older.messages.map((m) => m.body)).toEqual([
			"msg 0",
			"msg 1",
			"msg 2",
			"msg 3",
			"msg 4",
		]);
		expect(older.has_more).toBe(false);

		const m51 = latest.messages.find((m) => m.body === "msg 51")!;
		const newer = await page(groupId, a.cookie, `?after=${messageCursor(m51)}`);
		expect(newer.messages.map((m) => m.body)).toEqual(["msg 52", "msg 53", "msg 54"]);
		expect(newer.has_more).toBe(false);

		const none = await page(groupId, a.cookie, `?after=${latest.after}`);
		expect(none.messages).toEqual([]);
		expect(none.after).toBe(latest.after);
	});

	it("?after= returns a message committed later even if stamped with an earlier created_at", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		await postJson(`/groups/${groupId}/messages`, { body: "first" }, a.cookie);
		const seen = await page(groupId, b.cookie);
		expect(seen.messages.map((m) => m.body)).toEqual(["first"]);
		// A write whose timestamp was taken before "first" but that committed after it.
		const early = new Date(Date.parse(seen.messages[0]!.created_at) - 5_000).toISOString();
		await env.DB.prepare(
			`INSERT INTO messages (id, group_id, user_id, body, created_at, seq)
			 SELECT 'late-commit', ?, ?, 'late', ?, COALESCE((SELECT MAX(seq) FROM messages), 0) + 1`,
		)
			.bind(groupId, a.id, early)
			.run();
		const poll = await page(groupId, b.cookie, `?after=${seen.after}`);
		expect(poll.messages.map((m) => m.body)).toEqual(["late"]);
		expect(Number(poll.after)).toBeGreaterThan(Number(seen.after));
	});

	it("rejects a malformed or empty cursor, or both cursors (400 bad_cursor)", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		for (const q of [
			"?before=garbage",
			"?after=1%27%20OR%201=1",
			"?after=-1",
			"?after=1.5",
			"?before=",
			"?after=",
			`?before=${encodeURIComponent("2026-01-01T00:00:00.000Z|m-1")}`,
			"?before=5&after=3",
		]) {
			const res = await call(`/groups/${groupId}/messages${q}`, { cookie: a.cookie });
			expect(res.status, q).toBe(400);
			expect(await errCode(res), q).toBe("bad_cursor");
		}
	});

	it("message reads are rate-limited per user (429)", async () => {
		freezeClock();
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		for (let i = 0; i < LIMITS.messageRead.perMinute; i++)
			expect((await call(`/groups/${groupId}/messages`, { cookie: a.cookie })).status).toBe(200);
		expect((await call(`/groups/${groupId}/messages`, { cookie: a.cookie })).status).toBe(429);
	});
});

describe("deleting a message", () => {
	it("is own-only and soft: hidden from the room, body kept in D1", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		const { message } = await (
			await postJson(`/groups/${groupId}/messages`, { body: "regrettable" }, a.cookie)
		).json<any>();

		const theirs = await postJson(`/messages/${message.id}/delete`, {}, b.cookie);
		expect(theirs.status).toBe(404);
		expect((await page(groupId, b.cookie)).messages).toHaveLength(1);

		expect((await postJson(`/messages/${message.id}/delete`, {}, a.cookie)).status).toBe(200);
		expect((await page(groupId, a.cookie)).messages).toEqual([]);
		expect((await page(groupId, b.cookie)).messages).toEqual([]);
		const row = await env.DB.prepare(
			"SELECT body, deleted_at, deleted_by FROM messages WHERE id = ?",
		)
			.bind(message.id)
			.first<{ body: string; deleted_at: string | null; deleted_by: string }>();
		expect(row?.body).toBe("regrettable");
		expect(row?.deleted_at).not.toBeNull();
		expect(row?.deleted_by).toBe("author");

		expect((await postJson(`/messages/${message.id}/delete`, {}, a.cookie)).status).toBe(404);
		expect((await postJson(`/messages/no-such-message/delete`, {}, a.cookie)).status).toBe(404);
	});
});

describe("links and new accounts", () => {
	it("a new account cannot post links (400 links_not_allowed); nothing is stored", async () => {
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		for (const body of [
			"see https://scam.example",
			"www.tickets.example",
			"buy at cheapseats.com",
			"mail me a@b.co",
		]) {
			const res = await postJson(`/groups/${groupId}/messages`, { body }, a.cookie);
			expect(res.status, body).toBe(400);
			expect(await errCode(res)).toBe("links_not_allowed");
		}
		expect((await page(groupId, a.cookie)).messages).toEqual([]);
	});

	it("an account older than 7 days may post links", async () => {
		const a = await tagalongUser({ old: true });
		const { groupId } = await groupWith(a);
		const res = await postJson(
			`/groups/${groupId}/messages`,
			{ body: "map: https://maps.example/x" },
			a.cookie,
		);
		expect(res.status).toBe(201);
	});

	it("a moderator-trusted new account may post links", async () => {
		const mod = await signedInUser({ id: MODERATOR_ID });
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		expect(
			(await postJson(`/groups/${groupId}/messages`, { body: "x.com" }, a.cookie)).status,
		).toBe(400);
		expect((await postJson(`/mod/users/${a.id}/trust`, {}, mod.cookie)).status).toBe(200);
		expect(
			(await postJson(`/groups/${groupId}/messages`, { body: "x.com" }, a.cookie)).status,
		).toBe(201);
	});
});

describe("rate limits", () => {
	it("a new account gets the lower per-minute message limit, then 429", async () => {
		freezeClock();
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		const limit = LIMITS.message.new.perMinute;
		for (let i = 0; i < limit; i++)
			expect(
				(await postJson(`/groups/${groupId}/messages`, { body: `m${i}` }, a.cookie)).status,
			).toBe(201);
		const over = await postJson(`/groups/${groupId}/messages`, { body: "one more" }, a.cookie);
		expect(over.status).toBe(429);
		expect((await page(groupId, a.cookie)).messages).toHaveLength(limit);
	});

	it("a trusted account may send past the new-account limit", async () => {
		freezeClock();
		const a = await tagalongUser({ old: true });
		const { groupId } = await groupWith(a);
		for (let i = 0; i <= LIMITS.message.new.perMinute; i++)
			expect(
				(await postJson(`/groups/${groupId}/messages`, { body: `m${i}` }, a.cookie)).status,
			).toBe(201);
	});

	it("trusting a new account lifts its message limit", async () => {
		freezeClock();
		const mod = await signedInUser({ id: MODERATOR_ID });
		const a = await tagalongUser();
		const { groupId } = await groupWith(a);
		for (let i = 0; i < LIMITS.message.new.perMinute; i++)
			await postJson(`/groups/${groupId}/messages`, { body: `m${i}` }, a.cookie);
		expect((await postJson(`/groups/${groupId}/messages`, { body: "x" }, a.cookie)).status).toBe(
			429,
		);
		await postJson(`/mod/users/${a.id}/trust`, {}, mod.cookie);
		expect((await postJson(`/groups/${groupId}/messages`, { body: "y" }, a.cookie)).status).toBe(
			201,
		);
	});

	it("a new account may join only a few groups a day; a trusted one more", async () => {
		freezeClock();
		const fresh = await tagalongUser();
		const old = await tagalongUser({ old: true });
		const join = async (u: { id: string; cookie: string }) => {
			const eventId = await makeEvent();
			await makeEventPlan(u.id, eventId);
			return (await postJson(`/events/${eventId}/group/join`, {}, u.cookie)).status;
		};
		for (let i = 0; i < LIMITS.join.new.perDay; i++) expect(await join(fresh)).toBe(200);
		expect(await join(fresh)).toBe(429);
		for (let i = 0; i <= LIMITS.join.new.perDay; i++) expect(await join(old)).toBe(200);
	});
});
