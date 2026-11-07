/**
 * Tagalong rate limits (BUILD_SPEC §6: "new accounts are limited until they're
 * trusted"). A new account is one created under TRUST_AFTER_DAYS ago that no
 * moderator has trusted (see access.ts). Windows are fixed (lib/rate-limit.ts):
 * a "day" is a UTC calendar day.
 */
import { containsUrl } from "@tagalong/shared";
import { HttpError } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import type { TagalongUser } from "./access.js";

const MINUTE = 60;
const DAY = 86400;

export const LIMITS = {
	join: { trusted: { perDay: 10 }, new: { perDay: 3 } },
	message: { trusted: { perMinute: 20, perDay: 300 }, new: { perMinute: 6, perDay: 50 } },
	connect: { trusted: { perDay: 20 }, new: { perDay: 3 } },
	report: { trusted: { perDay: 20 }, new: { perDay: 20 } },
	/** WebSocket upgrades, everyone. */
	ws: { perMinute: 30 },
	/** Blocks and unblocks, everyone. Generous; only stops scripted abuse. */
	block: { perDay: 200 },
	/** Opt-in (name/city changes), everyone. */
	optIn: { perDay: 10 },
} as const;

const tier = (u: TagalongUser) => (u.trusted ? "trusted" : "new");

export async function limitJoin(db: D1Database, u: TagalongUser) {
	await rateLimit(db, `tg:join:${u.id}`, LIMITS.join[tier(u)].perDay, DAY);
}

/**
 * New accounts may not post links (any scheme, www., bare domain or e-mail).
 * Checked before the counters so a refused message costs nothing.
 */
export function checkMessageBody(u: TagalongUser, body: string) {
	if (!u.trusted && containsUrl(body))
		throw new HttpError(
			400,
			"links_not_allowed",
			"New accounts can't post links or e-mail addresses yet. Remove it and try again.",
		);
}

/** Group and DM messages share one budget. */
export async function limitMessage(db: D1Database, u: TagalongUser) {
	const l = LIMITS.message[tier(u)];
	await rateLimit(db, `tg:msg:m:${u.id}`, l.perMinute, MINUTE);
	await rateLimit(db, `tg:msg:d:${u.id}`, l.perDay, DAY);
}

export async function limitConnect(db: D1Database, u: TagalongUser) {
	await rateLimit(db, `tg:connect:${u.id}`, LIMITS.connect[tier(u)].perDay, DAY);
}

export async function limitReport(db: D1Database, u: TagalongUser) {
	await rateLimit(db, `tg:report:${u.id}`, LIMITS.report[tier(u)].perDay, DAY);
}

export async function limitBlock(db: D1Database, userId: string) {
	await rateLimit(db, `tg:block:${userId}`, LIMITS.block.perDay, DAY);
}

export async function limitOptIn(db: D1Database, userId: string) {
	await rateLimit(db, `tg:optin:${userId}`, LIMITS.optIn.perDay, DAY);
}

export async function limitWs(db: D1Database, userId: string) {
	await rateLimit(db, `ws:${userId}`, LIMITS.ws.perMinute, MINUTE);
}
