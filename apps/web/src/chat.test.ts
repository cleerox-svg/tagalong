import { messageCursor, type ChatMessage } from "@tagalong/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import {
	announcementFor,
	applyChatEvent,
	backoffDelay,
	chatErrorMessage,
	chatSocketUrl,
	CLOSE_POLICY,
	CLOSE_REMOVED,
	CLOSE_TOO_MANY,
	closeAction,
	compareMessages,
	dropAuthor,
	EMPTY_CHAT,
	isChatMessage,
	maxSeq,
	mergeMessages,
	olderCursor,
	parseChatEvent,
	pollCursor,
	removeMessage,
	type ChatState,
} from "./chat.js";

const msg = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
	id: `m${seq}`,
	room_kind: "group",
	room_id: "g1",
	user_id: "u1",
	name: "Sam",
	body: `body ${seq}`,
	seq,
	created_at: "2027-03-01T19:00:00.000Z",
	is_me: false,
	...over,
});

const ids = (s: ChatState) => s.messages.map((m) => m.id);

describe("mergeMessages", () => {
	it("sorts by seq (not created_at), oldest first", () => {
		const s = mergeMessages(EMPTY_CHAT, [
			msg(3, { created_at: "2027-01-01T00:00:00.000Z" }),
			msg(1, { created_at: "2027-01-03T00:00:00.000Z" }),
			msg(2),
		]);
		expect(ids(s)).toEqual(["m1", "m2", "m3"]);
	});

	it("dedupes by id; the incoming copy wins when it differs", () => {
		const s1 = mergeMessages(EMPTY_CHAT, [msg(1), msg(2)]);
		const s2 = mergeMessages(s1, [msg(2), msg(1)]);
		expect(s2).toBe(s1);
		const s3 = mergeMessages(s1, [msg(2, { body: "edited" })]);
		expect(ids(s3)).toEqual(["m1", "m2"]);
		expect(s3.messages[1]?.body).toBe("edited");
		const s4 = mergeMessages(s3, [msg(2, { body: "edited", seq: 9 })]);
		expect(s4).not.toBe(s3);
		expect(s4.messages.map((m) => m.seq)).toEqual([1, 9]);
	});

	it("returns the same state for an empty batch", () => {
		const s = mergeMessages(EMPTY_CHAT, [msg(1)]);
		expect(mergeMessages(s, [])).toBe(s);
	});

	it("never resurrects a deleted message (late poll or socket echo)", () => {
		const s = removeMessage(mergeMessages(EMPTY_CHAT, [msg(1), msg(2)]), "m1");
		expect(ids(s)).toEqual(["m2"]);
		const after = mergeMessages(s, [msg(1), msg(3)]);
		expect(ids(after)).toEqual(["m2", "m3"]);
		// Deleted before it was ever seen.
		const early = removeMessage(EMPTY_CHAT, "m7");
		expect(ids(mergeMessages(early, [msg(7)]))).toEqual([]);
		expect(mergeMessages(early, [msg(7)])).toBe(early);
	});

	it("does not mutate the previous state", () => {
		const s = mergeMessages(EMPTY_CHAT, [msg(2)]);
		const before = [...s.messages];
		mergeMessages(s, [msg(1)]);
		expect(s.messages).toEqual(before);
		expect(EMPTY_CHAT.messages).toEqual([]);
	});
});

describe("compareMessages", () => {
	it("breaks a seq tie by id and is 0 for the same id", () => {
		expect(compareMessages(msg(1, { id: "a" }), msg(1, { id: "b" }))).toBe(-1);
		expect(compareMessages(msg(1, { id: "b" }), msg(1, { id: "a" }))).toBe(1);
		expect(compareMessages(msg(1), msg(1))).toBe(0);
		expect(compareMessages(msg(2), msg(10))).toBe(-1);
	});
});

describe("removeMessage / dropAuthor", () => {
	it("removes and remembers; removing again is a no-op", () => {
		const s = mergeMessages(EMPTY_CHAT, [msg(1), msg(2)]);
		const r = removeMessage(s, "m1");
		expect(ids(r)).toEqual(["m2"]);
		expect(r.deleted.has("m1")).toBe(true);
		expect(s.deleted.has("m1")).toBe(false);
		expect(removeMessage(r, "m1")).toBe(r);
	});

	it("drops every message by one author, and is a no-op when none match", () => {
		const s = mergeMessages(EMPTY_CHAT, [
			msg(1, { user_id: "a" }),
			msg(2, { user_id: "b" }),
			msg(3, { user_id: "a" }),
		]);
		expect(ids(dropAuthor(s, "a"))).toEqual(["m2"]);
		expect(dropAuthor(s, "zz")).toBe(s);
	});
});

describe("applyChatEvent", () => {
	it("merges a message event and removes on a deleted event", () => {
		let s = applyChatEvent(EMPTY_CHAT, { type: "message", message: msg(1) });
		s = applyChatEvent(s, { type: "message", message: msg(2) });
		s = applyChatEvent(s, { type: "message", message: msg(1) });
		expect(ids(s)).toEqual(["m1", "m2"]);
		s = applyChatEvent(s, { type: "deleted", id: "m1" });
		expect(ids(s)).toEqual(["m2"]);
		s = applyChatEvent(s, { type: "message", message: msg(1) });
		expect(ids(s)).toEqual(["m2"]);
	});
});

describe("cursors", () => {
	it("are null when empty, else the newest/oldest seq via the shared messageCursor", () => {
		expect(pollCursor(EMPTY_CHAT)).toBeNull();
		expect(olderCursor(EMPTY_CHAT)).toBeNull();
		expect(maxSeq([])).toBeNull();
		const s = mergeMessages(EMPTY_CHAT, [msg(12), msg(5), msg(40)]);
		expect(pollCursor(s)).toBe("40");
		expect(olderCursor(s)).toBe("5");
		expect(pollCursor(s)).toBe(messageCursor(msg(40)));
		expect(maxSeq(s.messages)).toBe(40);
	});
});

describe("announcementFor", () => {
	const list = [
		msg(1, { name: "Ana", body: "old" }),
		msg(2, { name: "Me", body: "mine", is_me: true }),
		msg(3, { name: "Bo", body: "hi all" }),
	];

	it("is silent on first load and when nothing new from others", () => {
		expect(announcementFor(list, null)).toBeNull();
		expect(announcementFor(list, 3)).toBeNull();
		expect(announcementFor(list.slice(0, 2), 1)).toBeNull();
	});

	it("names a single new message, counts several", () => {
		expect(announcementFor(list, 2)).toBe("New message from Bo: hi all");
		expect(announcementFor(list, 0)).toBe("2 new messages.");
	});
});

describe("parseChatEvent / isChatMessage", () => {
	const good = { type: "message", message: msg(1) };

	it("parses a message and a deleted event", () => {
		expect(parseChatEvent(JSON.stringify(good))).toEqual(good);
		expect(parseChatEvent(JSON.stringify({ type: "deleted", id: "m1" }))).toEqual({
			type: "deleted",
			id: "m1",
		});
	});

	it("rejects malformed frames", () => {
		const bad: unknown[] = [
			"pong",
			"",
			"{",
			"null",
			"42",
			'"message"',
			JSON.stringify([]),
			JSON.stringify({ type: "message" }),
			JSON.stringify({ type: "message", message: null }),
			JSON.stringify({ type: "deleted" }),
			JSON.stringify({ type: "deleted", id: 5 }),
			JSON.stringify({ type: "typing", id: "m1" }),
			JSON.stringify({ ...good, type: "MESSAGE" }),
			new ArrayBuffer(4),
			undefined,
			null,
			{ type: "deleted", id: "m1" },
		];
		for (const f of bad) expect(parseChatEvent(f), String(f)).toBeNull();
	});

	it("requires every message field with the right type, and a non-negative safe integer seq", () => {
		const base = msg(1) as unknown as Record<string, unknown>;
		expect(isChatMessage(base)).toBe(true);
		for (const key of [
			"id",
			"room_kind",
			"room_id",
			"user_id",
			"name",
			"body",
			"seq",
			"created_at",
			"is_me",
		]) {
			const { [key]: _drop, ...rest } = base;
			expect(isChatMessage(rest), `missing ${key}`).toBe(false);
		}
		for (const [key, value] of [
			["room_kind", "post"],
			["is_me", "true"],
			["body", 7],
			["seq", -1],
			["seq", 1.5],
			["seq", "3"],
			["seq", Number.NaN],
			["seq", Number.MAX_SAFE_INTEGER + 2],
		] as const) {
			expect(isChatMessage({ ...base, [key]: value }), `${key}=${String(value)}`).toBe(false);
			expect(
				parseChatEvent(JSON.stringify({ type: "message", message: { ...base, [key]: value } })),
			).toBeNull();
		}
		expect(isChatMessage({ ...base, seq: 0 })).toBe(true);
		expect(isChatMessage(null)).toBe(false);
		expect(isChatMessage("m1")).toBe(false);
	});
});

describe("chatSocketUrl", () => {
	it("maps https to wss and http to ws, and encodes the id", () => {
		expect(chatSocketUrl("https://tagalong-api.averrow.com", "group", "g1")).toBe(
			"wss://tagalong-api.averrow.com/chat/group/g1/ws",
		);
		expect(chatSocketUrl("http://localhost:8787/", "dm", "c 1/../x")).toBe(
			"ws://localhost:8787/chat/dm/c%201%2F..%2Fx/ws",
		);
		// Schemes are case-insensitive: an upper-case base still yields a secure socket.
		expect(new URL(chatSocketUrl("HTTPS://API.example", "dm", "c")).protocol).toBe("wss:");
	});
});

describe("backoffDelay", () => {
	it("doubles from 1s and caps at 30s, with jitter within ±25%", () => {
		expect(backoffDelay(0)).toBe(750);
		expect(backoffDelay(0, 0.5)).toBe(1000);
		expect(backoffDelay(1, 0.5)).toBe(2000);
		expect(backoffDelay(3, 0.5)).toBe(8000);
		expect(backoffDelay(50, 0.5)).toBe(30_000);
		expect(backoffDelay(-3, 0.5)).toBe(1000);
		for (let attempt = 0; attempt < 40; attempt++)
			for (const jitter of [0, 0.25, 0.5, 0.999]) {
				const d = backoffDelay(attempt, jitter);
				expect(d).toBeGreaterThanOrEqual(750);
				expect(d).toBeLessThanOrEqual(37_500);
			}
	});
});

describe("closeAction", () => {
	it("4001 is removed; 4002 and 1008 poll; anything else reconnects", () => {
		expect(CLOSE_REMOVED).toBe(4001);
		expect(CLOSE_TOO_MANY).toBe(4002);
		expect(CLOSE_POLICY).toBe(1008);
		expect(closeAction(4001)).toBe("removed");
		expect(closeAction(4002)).toBe("poll");
		expect(closeAction(1008)).toBe("poll");
		for (const code of [1000, 1001, 1005, 1006, 1011, 4000, 4999])
			expect(closeAction(code), String(code)).toBe("reconnect");
	});
});

describe("chatErrorMessage", () => {
	it("gives plain-language text per status", () => {
		expect(chatErrorMessage(new Error("boom"))).toMatch(/connection/);
		expect(chatErrorMessage(new ApiError(429, "rate_limited", "x"))).toMatch(/too quickly/);
		expect(chatErrorMessage(new ApiError(400, "links_not_allowed", "x"))).toMatch(/links/);
		expect(chatErrorMessage(new ApiError(401, "signed_out", "x"))).toMatch(/signed out/);
		expect(chatErrorMessage(new ApiError(404, "not_found", "x"))).toMatch(/isn't available/);
	});
});
