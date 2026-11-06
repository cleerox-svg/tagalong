import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { vi } from "vitest";
import { startSession } from "../auth/session.js";
import app from "../index.js";
import type { AppEnv } from "../lib/http.js";

export const WEB = "https://tagalong.averrow.com";
export const API = "https://tagalong-api.averrow.com";

/** Calls the Worker in-process and waits for its waitUntil work (the planning run). */
export async function call(
	path: string,
	init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.cookie) headers.set("Cookie", init.cookie);
	const ctx = createExecutionContext();
	const res = await app.fetch(new Request(`${API}${path}`, { ...init, headers }), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

export const postJson = (path: string, body: unknown, cookie?: string, origin = WEB) =>
	call(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: origin },
		body: JSON.stringify(body),
		...(cookie ? { cookie } : {}),
	});

let n = 0;
/** Inserts a user and returns a valid session cookie for them. */
export async function signedInUser(
	opts: { adult?: boolean } = {},
): Promise<{ id: string; cookie: string }> {
	const id = `user-${++n}-${crypto.randomUUID()}`;
	await env.DB.prepare(
		"INSERT INTO users (id, google_sub, email, display_name, birthdate_verified_18, home_currency) VALUES (?, ?, ?, ?, ?, 'CAD')",
	)
		.bind(id, `sub-${id}`, `${id}@example.com`, `User ${n}`, opts.adult === false ? 0 : 1)
		.run();
	const minter = new Hono<AppEnv>();
	minter.get("/", async (c) => {
		await startSession(c, id);
		return c.text("ok");
	});
	const res = await minter.fetch(new Request(API), env, createExecutionContext());
	const setCookie = res.headers.get("Set-Cookie") ?? "";
	return { id, cookie: setCookie.split(";")[0] ?? "" };
}

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

/** Replaces outbound fetch. Any request no route answers fails the test loudly. */
export function mockFetch(...routes: Route[]) {
	const calls: URL[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		calls.push(url);
		for (const r of routes) {
			const res = await r(url, init);
			if (res) return res;
		}
		throw new Error(`unmocked fetch: ${url.origin}${url.pathname}`);
	});
	return { calls, spy };
}

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
