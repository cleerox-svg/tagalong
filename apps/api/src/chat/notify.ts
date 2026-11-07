/**
 * Worker-side calls into the ChatRoom Durable Object. Fan-out is best effort:
 * the message is already in D1, and a client whose socket missed it catches
 * up by polling `?after=`. A failed broadcast or kick is logged, not thrown.
 */
import type { ChatEvent, RoomKind } from "@tagalong/shared";

export const roomName = (kind: RoomKind, id: string) => `${kind}:${id}`;

export const roomStub = (env: Env, kind: RoomKind, id: string) =>
	env.CHAT_ROOM.getByName(roomName(kind, id));

export async function broadcast(
	env: Env,
	kind: RoomKind,
	id: string,
	event: ChatEvent,
	excludeUserIds: string[] = [],
): Promise<void> {
	try {
		await roomStub(env, kind, id).broadcast(event, excludeUserIds);
	} catch (err) {
		console.error("chat broadcast failed", roomName(kind, id), err);
	}
}

/** Closes the given users' sockets in one room. */
export async function kick(env: Env, kind: RoomKind, id: string, userIds: string[]) {
	await Promise.all(
		userIds.map(async (userId) => {
			try {
				await roomStub(env, kind, id).kick(userId);
			} catch (err) {
				console.error("chat kick failed", roomName(kind, id), err);
			}
		}),
	);
}

/** Closes one user's sockets in many rooms. */
export async function kickEverywhere(
	env: Env,
	userId: string,
	rooms: { kind: RoomKind; id: string }[],
) {
	await Promise.all(rooms.map((r) => kick(env, r.kind, r.id, [userId])));
}
