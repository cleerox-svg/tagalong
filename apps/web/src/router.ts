import { useEffect, useState } from "react";

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
