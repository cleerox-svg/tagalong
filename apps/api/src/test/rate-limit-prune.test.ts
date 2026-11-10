import {
	createExecutionContext,
	createScheduledController,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index.js";
import {
	IP_MAX_WINDOW_SECONDS,
	MAX_WINDOW_SECONDS,
	pruneRateLimits,
	rateLimit,
	rateLimitByIp,
} from "../lib/rate-limit.js";
import { call, mockFetch } from "./helpers.js";

// 2026-11-10T12:00:00Z, in ms and in seconds (window_start is Unix seconds).
const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
const NOW = NOW_MS / 1000;
const HOUR = 3600;
const DAY = 86_400;

let n = 0;
const uniq = (label: string) => `${label}-${++n}-${crypto.randomUUID()}`;

async function insert(key: string, windowStart: number) {
	await env.DB.prepare(
		`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
		 ON CONFLICT (key, window_start) DO NOTHING`,
	)
		.bind(key, windowStart)
		.run();
}

async function exists(key: string, windowStart: number): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 AS x FROM rate_limits WHERE key = ? AND window_start = ?",
	)
		.bind(key, windowStart)
		.first<{ x: number }>();
	return row !== null;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pruneRateLimits", () => {
	it("no window is longer than 24 hours, and no IP window longer than 1 hour", () => {
		expect(MAX_WINDOW_SECONDS).toBe(DAY);
		expect(IP_MAX_WINDOW_SECONDS).toBe(HOUR);
	});

	it("deletes rows whose window started more than 24 hours ago", async () => {
		const user = uniq("tg:join:user");
		const ip = `ip:shared:${uniq("203.0.113.7")}`;
		await insert(user, NOW - DAY - 1);
		await insert(user, NOW - 30 * DAY);
		await insert(ip, NOW - DAY - 60);
		await pruneRateLimits(env.DB, NOW_MS);
		expect(await exists(user, NOW - DAY - 1)).toBe(false);
		expect(await exists(user, NOW - 30 * DAY)).toBe(false);
		expect(await exists(ip, NOW - DAY - 60)).toBe(false);
	});

	it("keeps a non-IP row whose 24-hour window may still be live", async () => {
		// A per-day window that started today (UTC midnight) is still counting.
		const dayStart = Math.floor(NOW / DAY) * DAY;
		const user = uniq("tg:msg:d:user");
		await insert(user, dayStart);
		await insert(user, NOW - DAY + 1);
		await insert(user, NOW - 2 * HOUR);
		await pruneRateLimits(env.DB, NOW_MS);
		expect(await exists(user, dayStart)).toBe(true);
		expect(await exists(user, NOW - DAY + 1)).toBe(true);
		expect(await exists(user, NOW - 2 * HOUR)).toBe(true);
	});

	it("deletes IP-keyed rows after 1 hour, keeping live ones", async () => {
		const ip = `ip:signin:google:${uniq("198.51.100.4")}`;
		await insert(ip, NOW - HOUR - 1);
		await insert(ip, NOW - 6 * HOUR);
		await insert(ip, NOW - 60);
		await insert(ip, NOW);
		await pruneRateLimits(env.DB, NOW_MS);
		expect(await exists(ip, NOW - HOUR - 1)).toBe(false);
		expect(await exists(ip, NOW - 6 * HOUR)).toBe(false);
		expect(await exists(ip, NOW - 60)).toBe(true);
		expect(await exists(ip, NOW)).toBe(true);
	});

	it("drains more rows than one batch", async () => {
		const prefix = uniq("bulk");
		const stmt = env.DB.prepare(
			"INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)",
		);
		const rows = Array.from({ length: 5_050 }, (_, i) =>
			stmt.bind(`${prefix}:${i}`, NOW - 2 * DAY),
		);
		for (let i = 0; i < rows.length; i += 500) await env.DB.batch(rows.slice(i, i + 500));
		const deleted = await pruneRateLimits(env.DB, NOW_MS);
		expect(deleted).toBeGreaterThanOrEqual(5_050);
		const left = await env.DB.prepare(
			"SELECT COUNT(*) AS c FROM rate_limits WHERE substr(key, 1, ?) = ?",
		)
			.bind(prefix.length, prefix)
			.first<{ c: number }>();
		expect(left?.c).toBe(0);
	});

	it("still enforces the limit inside a live window after a prune", async () => {
		const key = uniq("limit");
		await rateLimit(env.DB, key, 1, 60);
		await pruneRateLimits(env.DB, Date.now());
		await expect(rateLimit(env.DB, key, 1, 60)).rejects.toMatchObject({ status: 429 });
	});

	it("refuses windows that pruning would cut short", async () => {
		await expect(rateLimit(env.DB, uniq("x"), 1, DAY + 1)).rejects.toThrow();
		await expect(rateLimitByIp(env.DB, "x", "192.0.2.1", 1, HOUR + 1)).rejects.toThrow();
	});
});

describe("IP-keyed call sites", () => {
	it("GET /shared/:token stores its IP row under the prunable ip: prefix", async () => {
		const ip = "192.0.2.55";
		const res = await call("/shared/not-a-real-token", { headers: { "CF-Connecting-IP": ip } });
		expect(res.status).toBe(404);
		const keys = await env.DB.prepare("SELECT key FROM rate_limits WHERE key LIKE ?")
			.bind(`%${ip}%`)
			.all<{ key: string }>();
		expect(keys.results.map((r) => r.key)).toEqual([`ip:shared:${ip}`]);
	});
});

describe("scheduled()", () => {
	async function runCron(e: Env = env) {
		const ctx = createExecutionContext();
		await worker.scheduled(
			createScheduledController({ scheduledTime: NOW_MS, cron: "23 */6 * * *" }),
			e,
			ctx,
		);
		await waitOnExecutionContext(ctx);
	}

	it("prunes expired rate-limit rows on every cron run", async () => {
		mockFetch(() => undefined);
		const old = `ip:native-exchange:${uniq("203.0.113.9")}`;
		const live = uniq("tg:join:user");
		await insert(old, NOW - 2 * HOUR);
		await insert(live, NOW - HOUR);
		await runCron();
		expect(await exists(old, NOW - 2 * HOUR)).toBe(false);
		expect(await exists(live, NOW - HOUR)).toBe(true);
	});

	it("a failing prune logs a generic message and does not stop the price check", async () => {
		mockFetch(() => undefined);
		const ip = "203.0.113.200";
		const errors: unknown[][] = [];
		vi.spyOn(console, "error").mockImplementation((...args) => {
			errors.push(args);
		});
		const logs: unknown[][] = [];
		vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args);
		});
		// Only the prune's statement fails, and its error quotes an IP.
		const db = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare")
					return (sql: string) => {
						if (sql.includes("DELETE FROM rate_limits"))
							throw new Error(`boom for key ip:shared:${ip}`);
						return target.prepare(sql);
					};
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		await runCron({ ...env, DB: db });
		expect(errors).toEqual([["rate-limit prune failed"]]);
		expect(JSON.stringify(errors)).not.toContain(ip);
		expect(logs.some((a) => a[0] === "saved-trip price check")).toBe(true);
	});
});
