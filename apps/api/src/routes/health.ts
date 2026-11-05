import { Hono } from "hono";

export const health = new Hono<{ Bindings: Env }>();

/**
 * Public. Queries D1 rather than just returning 200: a Worker that boots with a
 * broken database binding is not healthy.
 */
health.get("/health", async (c) => {
	let db: "ok" | "error" = "error";
	try {
		const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
		if (row?.ok === 1) db = "ok";
	} catch {
		db = "error";
	}

	return c.json({ ok: db === "ok", version: c.env.GIT_SHA, db }, db === "ok" ? 200 : 503);
});
