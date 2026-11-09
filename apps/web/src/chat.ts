/**
 * Tagalong chat: a pure message-list reducer (unit-tested) and the `useChat`
 * hook that drives it from a receive-only WebSocket, with a polling fallback.
 *
 * The socket only ever delivers `ChatEvent`s; every send and delete is an
 * HTTP POST (CSRF rule). D1 is the only store, so when the socket is down we
 * poll `GET …/messages?after=<cursor>` and merge; merging is idempotent.
 */
import { messageCursor, type ChatEvent, type ChatMessage, type RoomKind } from "@tagalong/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_BASE, ApiError } from "./api.js";
import { isNative } from "./native.js";

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

/**
 * Oldest first, by the server's `seq` (commit order, so equal timestamps
 * can't reorder); id breaks a tie so the order is total even on bad data.
 */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
	if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
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
		if (prev && prev.body === m.body && prev.seq === m.seq && prev.created_at === m.created_at)
			continue;
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

/** The `after` cursor for polling and catch-up: the newest message, or null when empty. */
export function pollCursor(state: ChatState): string | null {
	const last = state.messages.at(-1);
	return last ? messageCursor(last) : null;
}

/** The `before` cursor for loading earlier messages: the oldest message, or null when empty. */
export function olderCursor(state: ChatState): string | null {
	const first = state.messages[0];
	return first ? messageCursor(first) : null;
}

/** The highest `seq` in the list, or null when empty. */
export function maxSeq(messages: readonly ChatMessage[]): number | null {
	return messages.length === 0 ? null : (messages.at(-1)?.seq ?? null);
}

/**
 * What a screen reader should hear after the list changed: only messages from
 * other people with a `seq` above `sinceSeq` (so history, "load earlier" and
 * your own sends stay quiet). Null when there is nothing to announce.
 */
export function announcementFor(
	messages: readonly ChatMessage[],
	sinceSeq: number | null,
): string | null {
	if (sinceSeq === null) return null;
	const fresh = messages.filter((m) => m.seq > sinceSeq && !m.is_me);
	if (fresh.length === 0) return null;
	if (fresh.length === 1) {
		const m = fresh[0] as ChatMessage;
		return `New message from ${m.name}: ${m.body}`;
	}
	return `${fresh.length} new messages.`;
}

const isStr = (v: unknown): v is string => typeof v === "string";

export function isChatMessage(v: unknown): v is ChatMessage {
	if (!v || typeof v !== "object") return false;
	const m = v as Record<string, unknown>;
	return (
		isStr(m.id) &&
		(m.room_kind === "group" || m.room_kind === "dm") &&
		isStr(m.room_id) &&
		isStr(m.user_id) &&
		isStr(m.name) &&
		isStr(m.body) &&
		typeof m.seq === "number" &&
		Number.isSafeInteger(m.seq) &&
		m.seq >= 0 &&
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

/**
 * Add a socket ticket to the chat URL. The app has no session cookie, so it
 * fetches a short-lived ticket (60 s, bound to the user and the room) from
 * `POST /chat/ticket` before every connect.
 */
export function withTicket(url: string, ticket: string): string {
	return `${url}${url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
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
/** If the socket hasn't opened by now, load the history over HTTP anyway. */
export const FIRST_LOAD_FALLBACK_MS = 1500;

/** Socket close codes the API uses (see apps/api chat room). */
export const CLOSE_REMOVED = 4001;
export const CLOSE_TOO_MANY = 4002;
/** Policy violation: the client sent a frame on the receive-only socket. */
export const CLOSE_POLICY = 1008;

/**
 * What to do when the socket closes:
 * - "removed": we were removed from the room; check access over HTTP now, and
 *   stop for good if that 403s/404s.
 * - "poll": the server won't take this socket (too many connections, or a
 *   policy close); stop reconnecting and poll instead.
 * - "reconnect": anything else; poll meanwhile and reconnect with backoff.
 */
export type CloseAction = "removed" | "poll" | "reconnect";
export function closeAction(code: number): CloseAction {
	if (code === CLOSE_REMOVED) return "removed";
	if (code === CLOSE_TOO_MANY || code === CLOSE_POLICY) return "poll";
	return "reconnect";
}

// ---------------------------------------------------------------------------
// The hook.
// ---------------------------------------------------------------------------

/** "closed": access was lost (401/403/404); nothing more will load. */
export type ChatConnection = "connecting" | "live" | "polling" | "closed";

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
const isAccessError = (err: unknown) =>
	err instanceof ApiError && [401, 403, 404].includes(err.status);

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
	const olderBusy = useRef(false);

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
		let firstLoadTimer: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		/** Set on 401/403/404: stop polling and reconnecting for good. */
		let dead = false;
		/** Set on 4002 / 1008: the server won't take a socket; poll only. */
		let socketRefused = false;
		let loadedOnce = false;
		/** The catch-up in flight, so callers join it instead of stacking requests. */
		let inFlight: Promise<void> | null = null;
		/** Someone asked for a catch-up while one was running: run once more after it. */
		let again = false;

		roomRef.current = `${kind}:${id}`;
		stateRef.current = EMPTY_CHAT;
		olderBusy.current = false;
		setState(EMPTY_CHAT);
		setLoaded(false);
		setError(null);
		setHasOlder(false);
		setConnection("connecting");

		const stopPolling = () => {
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
		};
		const closeSocket = () => {
			if (!socket) return;
			const s = socket;
			socket = null;
			s.close(1000, "leaving");
		};

		/**
		 * Fetch what's newer than what we have (or the latest page on first
		 * load). Drains up to a few pages so a long absence catches up fully.
		 */
		const fetchNew = async () => {
			try {
				for (let n = 0; n < 10 && !stopped; n++) {
					const after = pollCursor(stateRef.current);
					const page = await api.messages(kind, id, after ? { after } : {});
					if (stopped) return;
					update((s) => mergeMessages(s, page.messages));
					loadedOnce = true;
					setLoaded(true);
					if (!after) {
						setHasOlder(page.has_more ?? page.messages.length >= PAGE);
						return;
					}
					if (!page.has_more || page.messages.length === 0) return;
				}
			} catch (err) {
				if (stopped) return;
				loadedOnce = true;
				setLoaded(true);
				// A poll that fails quietly retries; losing access is worth saying.
				if (isAccessError(err)) {
					dead = true;
					stopPolling();
					if (reconnectTimer) clearTimeout(reconnectTimer);
					closeSocket();
					setConnection("closed");
					setError(chatErrorMessage(err));
				}
			}
		};

		const catchUp = (): Promise<void> => {
			if (stopped || dead) return Promise.resolve();
			if (inFlight) {
				again = true;
				return inFlight;
			}
			const run = async () => {
				try {
					do {
						again = false;
						await fetchNew();
					} while (again && !stopped && !dead);
				} finally {
					inFlight = null;
				}
			};
			inFlight = run();
			return inFlight;
		};

		const startPolling = () => {
			if (pollTimer || dead || stopped) return;
			setConnection("polling");
			pollTimer = setInterval(() => {
				// Skip a tick rather than queue behind a slow request.
				if (!inFlight && document.visibilityState !== "hidden") void catchUp();
			}, POLL_MS);
		};

		const scheduleReconnect = () => {
			if (stopped || dead || socketRefused) return;
			reconnectTimer = setTimeout(connect, backoffDelay(attempt++, Math.random()));
		};

		const connect = () => {
			reconnectTimer = undefined;
			if (stopped || dead || socketRefused) return;
			const url = chatSocketUrl(API_BASE, kind, id);
			if (!isNative()) {
				openSocket(url);
				return;
			}
			// In the app: a fresh short-lived ticket for every attempt.
			void (async () => {
				let ticket: string | undefined;
				try {
					ticket = (await api.chatTicket(kind, id))?.ticket;
				} catch {
					ticket = undefined;
				}
				if (stopped || dead || socketRefused) return;
				if (typeof ticket === "string" && ticket) {
					openSocket(withTicket(url, ticket));
					return;
				}
				// Polling finds out whether we lost access (and stops if so).
				void catchUp();
				startPolling();
				scheduleReconnect();
			})();
		};

		const openSocket = (url: string) => {
			let ws: WebSocket;
			try {
				ws = new WebSocket(url);
			} catch {
				void catchUp();
				startPolling();
				return;
			}
			socket = ws;
			ws.onopen = () => {
				if (stopped || socket !== ws) return;
				attempt = 0;
				if (firstLoadTimer) clearTimeout(firstLoadTimer);
				setConnection("live");
				stopPolling();
				// The first load, or anything sent while we were away. Joins (and
				// then repeats) a fetch already running, so nothing sent between
				// that fetch and this subscription is missed.
				void catchUp();
			};
			ws.onmessage = (e: MessageEvent) => {
				const event = parseChatEvent(e.data);
				if (event) update((s) => applyChatEvent(s, event));
			};
			ws.onclose = (e: CloseEvent) => {
				if (stopped || socket !== ws) return;
				socket = null;
				if (dead) return;
				const action = closeAction(e.code);
				if (action === "removed") {
					// Find out now whether we still belong here; stop if not.
					void catchUp().then(() => {
						if (stopped || dead) return;
						startPolling();
						scheduleReconnect();
					});
					return;
				}
				if (action === "poll") socketRefused = true;
				if (!loadedOnce || action === "poll") void catchUp();
				startPolling();
				scheduleReconnect();
			};
			// onclose follows onerror; nothing else to do here.
			ws.onerror = () => undefined;
		};

		if (typeof WebSocket === "undefined") {
			void catchUp();
			startPolling();
		} else {
			// The socket's onopen does the first load; this covers a socket that
			// hangs without opening or closing.
			firstLoadTimer = setTimeout(() => {
				if (!loadedOnce) void catchUp();
			}, FIRST_LOAD_FALLBACK_MS);
			connect();
		}

		return () => {
			stopped = true;
			stopPolling();
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (firstLoadTimer) clearTimeout(firstLoadTimer);
			closeSocket();
		};
	}, [kind, id, update]);

	const send = useCallback(
		async (body: string) => {
			const room = `${kind}:${id}`;
			setError(null);
			try {
				const res = await api.sendMessage(kind, id, body);
				if (res?.message && roomRef.current === room)
					update((s) => mergeMessages(s, [res.message]));
				return true;
			} catch (err) {
				if (roomRef.current === room) setError(chatErrorMessage(err));
				return false;
			}
		},
		[kind, id, update],
	);

	const remove = useCallback(
		async (messageId: string) => {
			const room = `${kind}:${id}`;
			setError(null);
			try {
				await api.deleteMessage(messageId);
				if (roomRef.current === room) update((s) => removeMessage(s, messageId));
			} catch (err) {
				if (roomRef.current === room) setError(chatErrorMessage(err));
			}
		},
		[kind, id, update],
	);

	const hideAuthor = useCallback(
		(userId: string) => update((s) => dropAuthor(s, userId)),
		[update],
	);

	const loadOlder = useCallback(async () => {
		const room = `${kind}:${id}`;
		if (roomRef.current !== room || olderBusy.current) return;
		const before = olderCursor(stateRef.current);
		if (!before) return;
		olderBusy.current = true;
		try {
			const page = await api.messages(kind, id, { before });
			if (roomRef.current !== room) return;
			update((s) => mergeMessages(s, page.messages));
			setHasOlder(page.has_more ?? page.messages.length >= PAGE);
		} catch (err) {
			if (roomRef.current === room) setError(chatErrorMessage(err));
		} finally {
			if (roomRef.current === room) olderBusy.current = false;
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
