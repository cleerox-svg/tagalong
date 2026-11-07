/**
 * Tagalong chat: a pure message-list reducer (unit-tested) and the `useChat`
 * hook that drives it from a receive-only WebSocket, with a polling fallback.
 *
 * The socket only ever delivers `ChatEvent`s; every send and delete is an
 * HTTP POST (CSRF rule). D1 is the only store, so when the socket is down we
 * poll `GET …/messages?after=<cursor>` and merge; merging is idempotent.
 */
import type { ChatEvent, ChatMessage, RoomKind } from "@tagalong/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_BASE, ApiError } from "./api.js";

// ---------------------------------------------------------------------------
// Pure state.
// ---------------------------------------------------------------------------

export interface ChatState {
	/** Visible messages, oldest first, unique by id, none deleted. */
	messages: ChatMessage[];
	/** Ids seen as deleted, so a late poll or socket event can't bring them back. */
	deleted: ReadonlySet<string>;
}

export const EMPTY_CHAT: ChatState = { messages: [], deleted: new Set() };

/** Oldest first: by created_at, then id so equal timestamps have a stable order. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
	if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

/**
 * Merge `incoming` into the list: dedupe by id (the incoming copy wins),
 * drop anything already known to be deleted, and keep it sorted. Returns the
 * same state object when nothing changed.
 */
export function mergeMessages(state: ChatState, incoming: readonly ChatMessage[]): ChatState {
	if (incoming.length === 0) return state;
	const byId = new Map(state.messages.map((m) => [m.id, m]));
	let changed = false;
	for (const m of incoming) {
		if (state.deleted.has(m.id)) continue;
		const prev = byId.get(m.id);
		if (prev && prev.body === m.body && prev.created_at === m.created_at) continue;
		byId.set(m.id, m);
		changed = true;
	}
	if (!changed) return state;
	return { ...state, messages: [...byId.values()].sort(compareMessages) };
}

/** Remove a message (deleted by its author or a moderator) and remember it. */
export function removeMessage(state: ChatState, id: string): ChatState {
	if (state.deleted.has(id) && !state.messages.some((m) => m.id === id)) return state;
	const deleted = new Set(state.deleted);
	deleted.add(id);
	return { messages: state.messages.filter((m) => m.id !== id), deleted };
}

/** Hide everything from one author (after blocking them). */
export function dropAuthor(state: ChatState, userId: string): ChatState {
	const messages = state.messages.filter((m) => m.user_id !== userId);
	return messages.length === state.messages.length ? state : { ...state, messages };
}

export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
	return event.type === "message"
		? mergeMessages(state, [event.message])
		: removeMessage(state, event.id);
}

/** The API's page marker: `<created_at>|<id>`, matching its (created_at, id) order. */
export const cursorOf = (m: Pick<ChatMessage, "created_at" | "id">) => `${m.created_at}|${m.id}`;

/** The `after` cursor for polling and catch-up: the newest message, or null when empty. */
export function pollCursor(state: ChatState): string | null {
	const last = state.messages.at(-1);
	return last ? cursorOf(last) : null;
}

/** The `before` cursor for loading earlier messages: the oldest message, or null when empty. */
export function olderCursor(state: ChatState): string | null {
	const first = state.messages[0];
	return first ? cursorOf(first) : null;
}

const isStr = (v: unknown): v is string => typeof v === "string";

function isChatMessage(v: unknown): v is ChatMessage {
	if (!v || typeof v !== "object") return false;
	const m = v as Record<string, unknown>;
	return (
		isStr(m.id) &&
		(m.room_kind === "group" || m.room_kind === "dm") &&
		isStr(m.room_id) &&
		isStr(m.user_id) &&
		isStr(m.name) &&
		isStr(m.body) &&
		isStr(m.created_at) &&
		typeof m.is_me === "boolean"
	);
}

/** Parse one socket frame. Anything malformed (or a ping/pong) is null. */
export function parseChatEvent(data: unknown): ChatEvent | null {
	if (!isStr(data)) return null;
	let v: unknown;
	try {
		v = JSON.parse(data);
	} catch {
		return null;
	}
	if (!v || typeof v !== "object") return null;
	const e = v as Record<string, unknown>;
	if (e.type === "message" && isChatMessage(e.message))
		return { type: "message", message: e.message };
	if (e.type === "deleted" && isStr(e.id)) return { type: "deleted", id: e.id };
	return null;
}

/** `https://api` → `wss://api/chat/<kind>/<id>/ws` (and http → ws). */
export function chatSocketUrl(apiBase: string, kind: RoomKind, id: string): string {
	const base = apiBase
		.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`)
		.replace(/\/$/, "");
	return `${base}/chat/${kind}/${encodeURIComponent(id)}/ws`;
}

/** Reconnect delay: 1s, 2s, 4s … capped at 30s. `jitter` is in [0, 1). */
export function backoffDelay(attempt: number, jitter = 0): number {
	const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
	return Math.round(base * (0.75 + jitter * 0.5));
}

/** A plain-language message for a failed send / delete / load. */
export function chatErrorMessage(err: unknown): string {
	if (!(err instanceof ApiError))
		return "That didn't go through. Check your connection and try again.";
	if (err.status === 429)
		return "You're sending messages too quickly. Wait a minute, then try again.";
	if (err.status === 400 && /link|url/i.test(`${err.code} ${err.message}`))
		return "New accounts can't post links or e-mail addresses yet. Remove the link and send again.";
	if (err.status === 401) return "You've been signed out. Sign in again to keep chatting.";
	if (err.status === 403)
		return err.message || "You can't send messages here. Your Tagalong access may be paused.";
	if (err.status === 404) return "This chat isn't available any more.";
	return err.message || "That didn't go through. Try again.";
}

export const POLL_MS = 5000;

// ---------------------------------------------------------------------------
// The hook.
// ---------------------------------------------------------------------------

export type ChatConnection = "connecting" | "live" | "polling";

export interface UseChat {
	messages: ChatMessage[];
	loaded: boolean;
	connection: ChatConnection;
	/** A load / send / delete error, in plain language. */
	error: string | null;
	clearError: () => void;
	/** Resolves true when sent. */
	send: (body: string) => Promise<boolean>;
	remove: (messageId: string) => Promise<void>;
	hideAuthor: (userId: string) => void;
	loadOlder: () => Promise<void>;
	hasOlder: boolean;
}

const PAGE = 50;

export function useChat(kind: RoomKind, id: string): UseChat {
	const [state, setState] = useState<ChatState>(EMPTY_CHAT);
	const [loaded, setLoaded] = useState(false);
	const [connection, setConnection] = useState<ChatConnection>("connecting");
	const [error, setError] = useState<string | null>(null);
	const [hasOlder, setHasOlder] = useState(false);
	// The latest state for async callbacks (cursor reads); kept in step by `update`.
	const stateRef = useRef(state);
	/** The room the state belongs to; a late reply for a previous room is dropped. */
	const roomRef = useRef(`${kind}:${id}`);

	// The ref is the source of truth so a cursor read straight after a merge is current.
	const update = useCallback((fn: (s: ChatState) => ChatState) => {
		const next = fn(stateRef.current);
		if (next === stateRef.current) return;
		stateRef.current = next;
		setState(next);
	}, []);

	useEffect(() => {
		let stopped = false;
		let socket: WebSocket | null = null;
		let pollTimer: ReturnType<typeof setInterval> | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		/** Set on 401/403/404: stop polling and reconnecting. */
		let dead = false;

		roomRef.current = `${kind}:${id}`;
		stateRef.current = EMPTY_CHAT;
		setState(EMPTY_CHAT);
		setLoaded(false);
		setError(null);
		setConnection("connecting");

		/**
		 * Fetch what's newer than what we have (or the latest page on first
		 * load). Drains up to a few pages so a long absence catches up fully.
		 */
		const catchUp = async () => {
			try {
				for (let n = 0; n < 10 && !stopped; n++) {
					const after = pollCursor(stateRef.current);
					const page = await api.messages(kind, id, after ? { after } : {});
					if (stopped) return;
					update((s) => mergeMessages(s, page.messages));
					setLoaded(true);
					if (!after) {
						setHasOlder(page.has_more ?? page.messages.length >= PAGE);
						return;
					}
					if (!page.has_more || page.messages.length === 0) return;
				}
			} catch (err) {
				if (stopped) return;
				setLoaded(true);
				// A poll that fails quietly retries; a 401/403/404 is worth saying.
				if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
					dead = true;
					stopPolling();
					setError(chatErrorMessage(err));
				}
			}
		};

		const startPolling = () => {
			if (pollTimer || dead) return;
			pollTimer = setInterval(() => {
				if (document.visibilityState !== "hidden") void catchUp();
			}, POLL_MS);
		};
		const stopPolling = () => {
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
		};

		const connect = () => {
			if (stopped || dead) return;
			if (typeof WebSocket === "undefined") {
				startPolling();
				return;
			}
			let ws: WebSocket;
			try {
				ws = new WebSocket(chatSocketUrl(API_BASE, kind, id));
			} catch {
				setConnection("polling");
				startPolling();
				return;
			}
			socket = ws;
			ws.onopen = () => {
				if (stopped) return;
				attempt = 0;
				setConnection("live");
				stopPolling();
				// Anything sent while we were away.
				void catchUp();
			};
			ws.onmessage = (e: MessageEvent) => {
				const event = parseChatEvent(e.data);
				if (event) update((s) => applyChatEvent(s, event));
			};
			ws.onclose = () => {
				if (stopped || socket !== ws) return;
				socket = null;
				if (dead) return;
				setConnection("polling");
				startPolling();
				reconnectTimer = setTimeout(connect, backoffDelay(attempt++, Math.random()));
			};
			// onclose follows onerror; nothing else to do here.
			ws.onerror = () => undefined;
		};

		void catchUp().then(() => {
			if (!stopped) connect();
		});

		return () => {
			stopped = true;
			stopPolling();
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (socket) {
				const s = socket;
				socket = null;
				s.close(1000, "leaving");
			}
		};
	}, [kind, id, update]);

	const send = useCallback(
		async (body: string) => {
			setError(null);
			try {
				const res = await api.sendMessage(kind, id, body);
				if (res?.message && roomRef.current === `${kind}:${id}`)
					update((s) => mergeMessages(s, [res.message]));
				return true;
			} catch (err) {
				setError(chatErrorMessage(err));
				return false;
			}
		},
		[kind, id, update],
	);

	const remove = useCallback(
		async (messageId: string) => {
			setError(null);
			try {
				await api.deleteMessage(messageId);
				update((s) => removeMessage(s, messageId));
			} catch (err) {
				setError(chatErrorMessage(err));
			}
		},
		[update],
	);

	const hideAuthor = useCallback(
		(userId: string) => update((s) => dropAuthor(s, userId)),
		[update],
	);

	const loadOlder = useCallback(async () => {
		const before = olderCursor(stateRef.current);
		if (!before) return;
		try {
			const page = await api.messages(kind, id, { before });
			if (roomRef.current !== `${kind}:${id}`) return;
			update((s) => mergeMessages(s, page.messages));
			setHasOlder(page.has_more ?? page.messages.length >= PAGE);
		} catch (err) {
			setError(chatErrorMessage(err));
		}
	}, [kind, id, update]);

	return {
		messages: state.messages,
		loaded,
		connection,
		error,
		clearError: useCallback(() => setError(null), []),
		send,
		remove,
		hideAuthor,
		loadOlder,
		hasOlder,
	};
}
