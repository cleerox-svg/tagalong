import { useCallback, useEffect, useRef, useState } from "react";
import {
	askForPushInContext,
	declinePushInContext,
	isNative,
	shouldOfferPush,
	type PushOutcome,
} from "./native.js";

/** What the in-place prompt says once it has been answered. */
export function pushOfferResult(answer: PushOutcome | "not_now"): string {
	switch (answer) {
		case "granted":
			return "Notifications are on for this phone.";
		case "denied":
			return "OK, no notifications. You can allow them later in your phone's Settings.";
		case "failed":
			return "We couldn't turn on notifications. You can try again from Notifications.";
		case "not_now":
			return "No problem. You can turn them on any time from Notifications.";
		default:
			return "You can turn notifications on any time from Notifications.";
	}
}

export interface PushOfferState {
	/** Which spot on the screen the prompt (or its answer) belongs to; null: none yet. */
	at: string | null;
	open: boolean;
	busy: boolean;
	message: string;
	/** Offer push here, if this phone should be asked (app only; never on the web). */
	offer: (at?: string) => void;
	turnOn: () => void;
	notNow: () => void;
}

/**
 * The in-context push offer: call `offer()` after the action that makes
 * notifications useful (a sent DM, a connection request, a saved trip), and
 * render `<PushOffer>` where it should appear. It only opens inside the app,
 * while the OS hasn't been asked and the offer wasn't answered before; the
 * system dialog only comes after "Turn on".
 */
export function usePushOffer(): PushOfferState {
	const [at, setAt] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const live = useRef(true);
	const busyRef = useRef(false);

	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);

	const offer = useCallback((where = "") => {
		if (!isNative()) return;
		void shouldOfferPush().then((ok) => {
			if (!ok || !live.current) return;
			setAt(where);
			setMessage("");
			setOpen(true);
		});
	}, []);

	const turnOn = useCallback(() => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		void askForPushInContext().then((outcome) => {
			busyRef.current = false;
			if (!live.current) return;
			setBusy(false);
			setOpen(false);
			setMessage(pushOfferResult(outcome));
		});
	}, []);

	const notNow = useCallback(() => {
		if (busyRef.current) return;
		declinePushInContext();
		setOpen(false);
		setMessage(pushOfferResult("not_now"));
	}, []);

	return { at, open, busy, message, offer, turnOn, notNow };
}

/**
 * The in-place prompt: a question with [Turn on] [Not now], then a one-line
 * answer. Renders nothing in the browser. Its text sits in a polite live
 * region that is always mounted, so both the question and the answer are
 * announced; focus moves to the answer when the buttons go away.
 */
export function PushOffer({
	state,
	question,
	at = "",
}: {
	state: PushOfferState;
	question: string;
	/** Matches the `at` passed to `offer()` when one screen has several spots. */
	at?: string;
}) {
	const here = state.at === at;
	const open = here && state.open;
	const box = useRef<HTMLDivElement>(null);
	const text = useRef<HTMLParagraphElement>(null);
	const hadFocus = useRef(false);

	useEffect(() => {
		if (!open && hadFocus.current) {
			hadFocus.current = false;
			text.current?.focus();
		}
	}, [open]);

	if (!isNative()) return null;

	const answer = (fn: () => void) => () => {
		hadFocus.current = box.current?.contains(document.activeElement) ?? false;
		fn();
	};

	return (
		<div ref={box} className={open ? "push-offer is-open" : "push-offer"}>
			<p ref={text} className="note push-offer-text" role="status" tabIndex={-1}>
				{open ? question : here ? state.message : ""}
			</p>
			{open && (
				<div className="push-offer-actions">
					<button
						type="button"
						className="primary"
						aria-disabled={state.busy || undefined}
						onClick={answer(state.turnOn)}
					>
						{state.busy ? "Turning on…" : "Turn on"}
					</button>
					<button
						type="button"
						aria-disabled={state.busy || undefined}
						onClick={answer(state.notNow)}
					>
						Not now
					</button>
				</div>
			)}
		</div>
	);
}
