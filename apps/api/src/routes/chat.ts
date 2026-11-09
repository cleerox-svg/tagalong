/**
 * Phase 5: the chat socket. GET /chat/group/:id/ws and GET /chat/dm/:id/ws.
 *
 * Every check happens here, in the Worker, before the Durable Object is
 * reached, in this order: a WebSocket upgrade; an Origin on the web allowlist
 * (cross-site WebSocket hijacking: browsers send cookies on cross-origin
 * upgrades and CORS does not apply); a valid session; 18+, opted in and not
 * suspended; a rate limit; then group membership, or for a DM an accepted
 * connection the user is party to with no block either way. Only then is the
 * upgrade forwarded, with the user id in X-Tg-User (any client copy dropped).
 * The socket is receive-only; sends go through the POST routes.
 *
 * Phase 6: the native app can't use the cookie and can't set headers on a
 * WebSocket, so it first gets a short-lived signed ticket from POST
 * /chat/ticket (bearer-authenticated, same access checks) and opens
 * .../ws?ticket=... from a NATIVE origin. A ticket is bound to user, room kind
 * and id, and lives 60 s. All the checks after authentication still run.
 */
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { RoomKind } from "@tagalong/shared";
import { z } from "zod";
import {
	assertUserExists,
	authenticate,
	b64url,
	requireAdult,
	requireUser,
	signToken,
	verifyToken,
} from "../auth/session.js";
import { roomStub } from "../chat/notify.js";
import { HttpError, readJson } from "../lib/http.js";
import { rateLimit } from "../lib/rate-limit.js";
import { NATIVE_ORIGINS, requireTrustedWrite, WEB_ORIGINS } from "../lib/security.js";
import { requireDm, requireMember, requireTagalong, type TgEnv } from "../tagalong/access.js";
import { LIMITS, limitWs } from "../tagalong/limits.js";

export const chat = new Hono<TgEnv>();

const TICKET_LABEL = "tagalong:chat-ticket:v1";
const TICKET_SECONDS = 60;

type Ticket = { u: string; k: RoomKind; i: string; e: number };

/** Membership for a group, an accepted unblocked connection for a DM; 404 otherwise. */
async function requireRoomAccess(db: D1Database, kind: RoomKind, id: string, me: string) {
	if (kind === "group") await requireMember(db, id, me);
	else await requireDm(db, id, me);
}

async function ticketUserId(
	env: Env,
	ticket: string,
	kind: string,
	id: string,
): Promise<string | null> {
	const payload = await verifyToken(env, TICKET_LABEL, ticket);
	if (!payload) return null;
	try {
		const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const t = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))) as Ticket;
		if (typeof t.u !== "string" || t.k !== kind || t.i !== id) return null;
		if (typeof t.e !== "number" || t.e * 1000 < Date.now()) return null;
		return t.u;
	} catch {
		return null;
	}
}

/**
 * Upgrade, Origin and who. Without ?ticket: a WEB origin and the cookie
 * session, as before. With ?ticket: a NATIVE origin and a valid ticket for
 * this exact room.
 */
const socketAuth = createMiddleware<TgEnv>(async (c, next) => {
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
		throw new HttpError(426, "upgrade_required", "Expected a WebSocket upgrade.");
	const origin = c.req.header("Origin") ?? "";
	const ticket = c.req.query("ticket");
	if (ticket === undefined) {
		if (!WEB_ORIGINS.includes(origin))
			throw new HttpError(403, "bad_origin", "Chat is only available from the Tagalong web app.");
		c.set("userId", await authenticate(c));
		return next();
	}
	if (!NATIVE_ORIGINS.includes(origin))
		throw new HttpError(403, "bad_origin", "Chat is only available from the Tagalong app.");
	const userId = await ticketUserId(
		c.env,
		ticket,
		c.req.param("kind") ?? "",
		c.req.param("id") ?? "",
	);
	if (!userId) throw new HttpError(401, "signed_out", "Sign in first.");
	await assertUserExists(c.env.DB, userId);
	c.set("userId", userId);
	return next();
});

chat.get("/chat/:kind{group|dm}/:id/ws", socketAuth, requireAdult, requireTagalong, async (c) => {
	const me = c.get("userId");
	const kind = c.req.param("kind") as RoomKind;
	const id = c.req.param("id");
	await limitWs(c.env.DB, me);
	await requireRoomAccess(c.env.DB, kind, id, me);

	const headers = new Headers({ Upgrade: "websocket", "X-Tg-User": me });
	for (const h of ["Sec-WebSocket-Key", "Sec-WebSocket-Version"]) {
		const v = c.req.header(h);
		if (v) headers.set(h, v);
	}
	return roomStub(c.env, kind, id).fetch(new Request("https://chat-room.internal/ws", { headers }));
});

const TicketRequest = z.strictObject({
	kind: z.enum(["group", "dm"]),
	id: z.string().min(1).max(200),
});

/** POST /chat/ticket {kind, id} → {ticket, expires_at}. Same access checks as the socket. */
chat.post(
	"/chat/ticket",
	requireTrustedWrite,
	requireUser,
	requireAdult,
	requireTagalong,
	async (c) => {
		const body = TicketRequest.safeParse(await readJson(c));
		if (!body.success) throw new HttpError(400, "invalid", "Pick a chat room.", body.error.issues);
		const me = c.get("userId");
		const { kind, id } = body.data;
		await rateLimit(c.env.DB, `ws-ticket:${me}`, LIMITS.ws.perMinute, 60);
		await requireRoomAccess(c.env.DB, kind, id, me);
		const e = Math.floor(Date.now() / 1000) + TICKET_SECONDS;
		const payload = b64url(new TextEncoder().encode(JSON.stringify({ u: me, k: kind, i: id, e })));
		return c.json({
			ticket: await signToken(c.env, TICKET_LABEL, payload),
			expires_at: new Date(e * 1000).toISOString(),
		});
	},
);
