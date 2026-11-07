/**
 * ChatRoom Durable Object (BUILD_SPEC §3, §6): one per group
 * ("group:<groupId>") or DM ("dm:<connectionId>"). Fan-out only. It stores
 * nothing: D1 is the only message store, and every send or delete goes
 * through an HTTP POST on the Worker (CSRF, validation, rate limits,
 * membership and block checks) before the Worker calls broadcast() here.
 *
 * The Worker is the only caller. It authenticates the socket, checks access
 * and forwards the upgrade with X-Tg-User; a Durable Object is not reachable
 * from the internet. Sockets are receive-only: "ping" gets "pong" through the
 * hibernation auto-response (the object is not woken); any other client
 * frame closes the socket with 1008.
 */
import { DurableObject } from "cloudflare:workers";
import type { ChatEvent } from "@tagalong/shared";
import type { Audience } from "./notify.js";

/** Close code sent when the server removes a user (left, blocked, suspended…). */
export const KICK_CLOSE_CODE = 4001;
/** Sockets one user may hold in one room; the oldest is closed beyond this. */
export const MAX_SOCKETS_PER_USER = 5;

const USER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export class ChatRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
			return new Response("Expected a WebSocket upgrade.", { status: 426 });
		const userId = request.headers.get("X-Tg-User") ?? "";
		if (!USER_ID_RE.test(userId)) return new Response("Bad request.", { status: 400 });

		const existing = this.ctx.getWebSockets(userId);
		for (const old of existing.slice(0, Math.max(0, existing.length - MAX_SOCKETS_PER_USER + 1)))
			safeClose(old, 4002, "Too many connections");

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server, [userId]);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Receive-only: any client frame other than the auto-answered "ping" is a policy violation. */
	override async webSocketMessage(ws: WebSocket): Promise<void> {
		safeClose(ws, 1008, "Receive-only");
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		safeClose(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		safeClose(ws, 1011, "error");
	}

	/**
	 * Sends `event` to the sockets of users in `audience.allow` and not in
	 * `audience.skip`. The Worker computes the audience from D1 at send time
	 * (current eligible members, minus block relations with the author); any
	 * socket whose user is no longer allowed here is closed with
	 * KICK_CLOSE_CODE, so a missed kick heals on the next event. A message's
	 * `is_me` is set per recipient. Returns how many sockets it reached.
	 */
	async broadcast(event: ChatEvent, audience: Audience): Promise<number> {
		const allow = new Set(audience.allow);
		const skip = new Set(audience.skip);
		let sent = 0;
		for (const ws of this.ctx.getWebSockets()) {
			const userId = this.ctx.getTags(ws)[0];
			if (!userId || !allow.has(userId)) {
				safeClose(ws, KICK_CLOSE_CODE, "Removed");
				continue;
			}
			if (skip.has(userId)) continue;
			const payload: ChatEvent =
				event.type === "message"
					? {
							type: "message",
							message: { ...event.message, is_me: event.message.user_id === userId },
						}
					: event;
			try {
				ws.send(JSON.stringify(payload));
				sent++;
			} catch {
				// A socket that is closing; the client catches up by polling.
			}
		}
		return sent;
	}

	/** Closes every socket of `userId` in this room. Returns how many. */
	async kick(userId: string): Promise<number> {
		const sockets = this.ctx.getWebSockets(userId);
		for (const ws of sockets) safeClose(ws, KICK_CLOSE_CODE, "Removed");
		return sockets.length;
	}

	/** Open sockets, for tests and diagnostics. */
	async socketCount(): Promise<number> {
		return this.ctx.getWebSockets().length;
	}
}

function safeClose(ws: WebSocket, code: number, reason: string) {
	try {
		ws.close(code, reason);
	} catch {
		// Already closed.
	}
}
