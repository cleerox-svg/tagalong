import type { ReactNode } from "react";
import { linkTo } from "./router.js";

/** "← Tagalong" (or another in-app destination), sized for a thumb. */
export function BackLink({
	to = "/connections",
	label = "Tagalong",
}: {
	to?: string;
	label?: string;
}) {
	return (
		<a className="tg-back" href={to} onClick={linkTo(to)}>
			← {label}
		</a>
	);
}

/** A dead-end state (failed load, gone, not allowed): what happened and a way out. */
export function ErrorCard({
	message,
	to,
	label,
	children,
}: {
	message: string;
	to?: string;
	label?: string;
	children?: ReactNode;
}) {
	return (
		<section className="card">
			<p className="error" role="alert">
				{message}
			</p>
			{children}
			<BackLink {...(to ? { to } : {})} {...(label ? { label } : {})} />
		</section>
	);
}
