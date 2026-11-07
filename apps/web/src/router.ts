import { useEffect, useState, type MouseEvent } from "react";

/** A two-route app does not need a router library. */
export function usePath(): string {
	const [path, setPath] = useState(window.location.pathname);
	useEffect(() => {
		const on = () => setPath(window.location.pathname);
		window.addEventListener("popstate", on);
		return () => window.removeEventListener("popstate", on);
	}, []);
	return path;
}

export function navigate(path: string): void {
	window.history.pushState(null, "", path);
	window.dispatchEvent(new PopStateEvent("popstate"));
	window.scrollTo(0, 0);
}

/**
 * An `onClick` for an in-app `<a href>`: client-side navigation on a plain
 * click, while modified clicks (new tab, etc.) keep the browser's behaviour.
 */
export const linkTo = (to: string) => (e: MouseEvent) => {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
		return;
	e.preventDefault();
	navigate(to);
};
