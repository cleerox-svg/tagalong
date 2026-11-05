import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
	it("returns 200 and reports the database as reachable", async () => {
		const response = await SELF.fetch("https://example.com/health");
		expect(response.status).toBe(200);
		const body = await response.json<{ ok: boolean; db: string; version: string }>();
		expect(body.ok).toBe(true);
		expect(body.db).toBe("ok");
	});

	it("returns a JSON 404 for unknown routes", async () => {
		const response = await SELF.fetch("https://example.com/nope");
		expect(response.status).toBe(404);
	});
});

describe("migrations", () => {
	it("creates the app_meta table", async () => {
		const { env } = await import("cloudflare:test");
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'",
		).first<{ name: string }>();
		expect(row?.name).toBe("app_meta");
	});
});
