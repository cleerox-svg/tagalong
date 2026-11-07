/**
 * Phase 5: the chat socket. GET /chat/group/:id/ws and GET /chat/dm/:id/ws.
 *
 * Every check happens here, in the Worker, before the Durable Object is
 * reached, in this order: a WebSocket upgrade; an Origin on the CORS allowlist
 * (cross-site WebSocket hijacking: browsers send cookies on cross-origin
 * upgrades and CORS does not apply); a valid session; 18+, opted in and not
 * suspended; a rate limit; then group membership, or for a DM an accepted
 * connection the user is party to with no block either way. Only then is the
 * upgrade forwarded, with the user id in X-Tg-User (any client copy dropped).
 * The socket is receive-only; sends go through the POST routes.
 */
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { RoomKind } from "@tagalong/shared";
import { requireAdult, requireUser } from "../auth/session.js";
import { roomStub } from "../chat/notify.js";
import { HttpError } from "../lib/http.js";
import { ALLOWED_ORIGINS } from "../lib/security.js";
import { requireDm, requireMember, requireTagalong, type TgEnv } from "../tagalong/access.js";
import { limitWs } from "../tagalong/limits.js";

export const chat = new Hono<TgEnv>();

const upgradeAndOrigin = createMiddleware<TgEnv>(async (c, next) => {
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
		throw new HttpError(426, "upgrade_required", "Expected a WebSocket upgrade.");
	const origin = c.req.header("Origin");
	if (!origin || !ALLOWED_ORIGINS.includes(origin))
		throw new HttpError(403, "bad_origin", "Chat is only available from the Tagalong web app.");
	return next();
});

chat.get(
	"/chat/:kind{group|dm}/:id/ws",
	upgradeAndOrigin,
	requireUser,
	requireAdult,
	requireTagalong,
	async (c) => {
		const me = c.get("userId");
		const kind = c.req.param("kind") as RoomKind;
		const id = c.req.param("id");
		await limitWs(c.env.DB, me);
		if (kind === "group") await requireMember(c.env.DB, id, me);
		else await requireDm(c.env.DB, id, me);

		const headers = new Headers({ Upgrade: "websocket", "X-Tg-User": me });
		for (const h of ["Sec-WebSocket-Key", "Sec-WebSocket-Version"]) {
			const v = c.req.header(h);
			if (v) headers.set(h, v);
		}
		return roomStub(c.env, kind, id).fetch(
			new Request("https://chat-room.internal/ws", { headers }),
		);
	},
);
