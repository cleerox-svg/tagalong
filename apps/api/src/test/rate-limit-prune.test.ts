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
	PRUNE_LIMITS,
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

	it("deletes legacy unprefixed IP rows after 1 hour, keeping user-keyed look-alikes", async () => {
		const legacy = [
			`shared:${uniq("203.0.113.8")}`,
			`native-exchange:${uniq("203.0.113.8")}`,
			`signin:google:${uniq("203.0.113.8")}`,
		];
		for (const key of legacy) {
			await insert(key, NOW - HOUR - 1);
			await insert(key, NOW - 60);
		}
		// share:<userId> limits share-link creation per user (1-hour window); not an IP.
		const share = `share:${uniq("user")}`;
		await insert(share, NOW - 2 * HOUR);
		await pruneRateLimits(env.DB, NOW_MS);
		for (const key of legacy) {
			expect(await exists(key, NOW - HOUR - 1)).toBe(false);
			expect(await exists(key, NOW - 60)).toBe(true);
		}
		expect(await exists(share, NOW - 2 * HOUR)).toBe(true);
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

	it("prunes every expired IP row first, even past the general cap", async () => {
		// Lowered caps: the general sweep may delete at most 2 x 10 = 20 rows,
		// and more than that many expired non-IP rows are waiting.
		const limits = { ...PRUNE_LIMITS, batchSize: 10, generalMaxBatches: 2 };
		const tag = uniq("backlog");
		const stmt = env.DB.prepare(
			"INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)",
		);
		await env.DB.batch(
			Array.from({ length: 60 }, (_, i) => stmt.bind(`tg:join:${tag}:${i}`, NOW - 2 * DAY)),
		);
		// More IP rows than one batch, under every IP prefix.
		const ipKeys = [
			...Array.from({ length: 25 }, (_, i) => `ip:shared:${tag}-${i}`),
			...Array.from({ length: 12 }, (_, i) => `ip:signin:google:${tag}-${i}`),
			`shared:${tag}`,
			`native-exchange:${tag}`,
			`signin:google:${tag}`,
		];
		await env.DB.batch(ipKeys.map((k) => stmt.bind(k, NOW - 2 * HOUR)));
		const live = `ip:shared:${tag}-live`;
		await insert(live, NOW - 60);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await pruneRateLimits(env.DB, NOW_MS, limits);

		for (const k of ipKeys) expect(await exists(k, NOW - 2 * HOUR)).toBe(false);
		expect(await exists(live, NOW - 60)).toBe(true);
		const left = await env.DB.prepare(
			"SELECT COUNT(*) AS c FROM rate_limits WHERE key >= ? AND key < ?",
		)
			.bind(`tg:join:${tag}:`, `tg:join:${tag};`)
			.first<{ c: number }>();
		// The general cap stopped the sweep; the rest waits for the next run.
		expect(left?.c).toBeGreaterThan(0);
	});

	it("logs a capped prune with counts only, never an IP", async () => {
		const limits = { ...PRUNE_LIMITS, batchSize: 2, ipMaxBatches: 1, generalMaxBatches: 1 };
		const ip = "203.0.113.250";
		for (const scope of ["shared", "signin:google", "native-exchange", "plan"])
			await insert(`ip:${scope}:${ip}`, NOW - 2 * HOUR);
		const tag = uniq("capped");
		for (let i = 0; i < 4; i++) await insert(`tg:msg:${tag}:${i}`, NOW - 2 * DAY);
		const out: unknown[][] = [];
		for (const level of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, level).mockImplementation((...args) => {
				out.push([level, ...args]);
			});

		const deleted = await pruneRateLimits(env.DB, NOW_MS, limits);

		const capped = out.filter((a) => a[1] === "rate-limit prune capped");
		expect(capped).toHaveLength(1);
		expect(capped[0]?.[0]).toBe("warn");
		const counts = capped[0]?.[2] as Record<string, unknown>;
		expect(Object.keys(counts).sort()).toEqual(["ipDeleted", "otherDeleted"]);
		for (const v of Object.values(counts)) expect(typeof v).toBe("number");
		expect(counts.ipDeleted).toBe(2);
		expect(deleted).toBe((counts.ipDeleted as number) + (counts.otherDeleted as number));
		expect(JSON.stringify(out)).not.toContain(ip);
	});

	it("does not log a cap when everything fits", async () => {
		await insert(`ip:shared:${uniq("192.0.2.9")}`, NOW - 2 * HOUR);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await pruneRateLimits(env.DB, NOW_MS);
		expect(warn).not.toHaveBeenCalled();
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

	/** Every console channel, captured, so no IP can slip out through any of them. */
	function captureConsole() {
		const out: unknown[][] = [];
		for (const level of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, level).mockImplementation((...args) => {
				out.push([level, ...args]);
			});
		return out;
	}

	it("a successful prune logs only a row count, never an IP", async () => {
		mockFetch(() => undefined);
		const ip = "198.51.100.231";
		await insert(`ip:shared:${ip}`, NOW - 2 * HOUR);
		await insert(`ip:signin:google:${ip}`, NOW - 3 * HOUR);
		await insert(`shared:${ip}`, NOW - 2 * HOUR);
		const out = captureConsole();
		await runCron();
		expect(await exists(`ip:shared:${ip}`, NOW - 2 * HOUR)).toBe(false);
		const prune = out.filter((a) => a[1] === "rate-limit prune");
		expect(prune).toHaveLength(1);
		expect(prune[0]?.[0]).toBe("log");
		expect(Object.keys(prune[0]?.[2] as object)).toEqual(["deleted"]);
		expect((prune[0]?.[2] as { deleted: number }).deleted).toBeGreaterThanOrEqual(3);
		expect(JSON.stringify(out)).not.toContain(ip);
		expect(out.some((a) => a[1] === "saved-trip price check")).toBe(true);
	});

	it("a prune whose statement rejects (not throws) still lets the price check run, with no IP logged", async () => {
		mockFetch(() => undefined);
		const ip = "198.51.100.232";
		const out = captureConsole();
		// prepare() succeeds; the D1 run fails asynchronously with an IP in its message.
		const db = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare")
					return (sql: string) => {
						if (!sql.includes("DELETE FROM rate_limits")) return target.prepare(sql);
						const failing = {
							bind: () => failing,
							run: () => Promise.reject(new Error(`D1_ERROR on ip:shared:${ip}`)),
						};
						return failing;
					};
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		await runCron({ ...env, DB: db });
		expect(out.filter((a) => a[0] === "error")).toEqual([["error", "rate-limit prune failed"]]);
		expect(out.some((a) => a[0] === "log" && a[1] === "rate-limit prune")).toBe(false);
		expect(out.some((a) => a[0] === "log" && a[1] === "saved-trip price check")).toBe(true);
		expect(JSON.stringify(out, (_k, v) => (v instanceof Error ? v.message : v))).not.toContain(ip);
	});

	it("a failing saved-trip check does not stop the prune", async () => {
		mockFetch(() => undefined);
		const old = `ip:shared:${uniq("203.0.113.77")}`;
		await insert(old, NOW - 2 * HOUR);
		const out = captureConsole();
		// Every read the price check makes fails; the prune's DELETE goes through.
		const db = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare")
					return (sql: string) => {
						if (sql.includes("DELETE FROM rate_limits")) return target.prepare(sql);
						throw new Error("saved trips unavailable");
					};
				const v = Reflect.get(target, prop, target);
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
		await runCron({ ...env, DB: db });
		expect(await exists(old, NOW - 2 * HOUR)).toBe(false);
		expect(out.some((a) => a[0] === "error" && a[1] === "saved-trip price check failed")).toBe(
			true,
		);
		expect(out.some((a) => a[0] === "log" && a[1] === "rate-limit prune")).toBe(true);
	});
});
