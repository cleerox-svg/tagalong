/**
 * Resend (https://resend.com/docs/api-reference/emails/send-email): sends the
 * price-drop alert. One call per alert; failures are recorded, not retried in
 * a loop.
 */
import { ProviderError } from "../lib/cache.js";

export interface Email {
	from: string;
	to: string;
	subject: string;
	text: string;
	html: string;
}

export async function sendEmail(apiKey: string, e: Email): Promise<string> {
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			from: e.from,
			to: [e.to],
			subject: e.subject,
			text: e.text,
			html: e.html,
		}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new ProviderError("resend", `HTTP ${res.status}`);
	const body = (await res.json().catch(() => ({}))) as { id?: string };
	return body.id ?? "";
}
