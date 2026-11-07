/**
 * Phase 5: Tagalong opt-in and its gates, /me, profiles, CSRF on Tagalong
 * writes, and the privacy rule: no Tagalong response ever carries an email,
 * home city or home coordinates (spec §6, §8).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	call,
	connect,
	groupWith,
	findPrivate,
	makeEvent,
	makeEventPlan,
	makeOldAccount,
	MODERATOR_ID,
	optIn,
	postJson,
	PRIVATE_HOME,
	setPrivateHome,
	signedInUser,
	tagalongUser,
	WEB,
} from "./helpers.js";

const errCode = async (res: Response) => (await res.json<{ error: { code: string } }>()).error.code;

const me = async (cookie: string) =>
	(await call("/me", { cookie })).json<{
		tagalong: {
			opted_in: boolean;
			name: string | null;
			city: string | null;
			safety_acked: boolean;
			trusted: boolean;
			suspended: boolean;
		};
		is_moderator: boolean;
	}>();

const suspend = (id: string) =>
	env.DB.prepare("UPDATE users SET tagalong_suspended_at = ? WHERE id = ?")
		.bind(new Date().toISOString(), id)
		.run();

describe("opt-in", () => {
	it("needs a session (401) and 18+ (403 age_unconfirmed)", async () => {
		const body = { confirm: true, name: "Sam", city: "Toronto" };
		expect((await postJson("/tagalong/opt-in", body)).status).toBe(401);
		const minor = await signedInUser({ adult: false });
		const res = await postJson("/tagalong/opt-in", body, minor.cookie);
		expect(res.status).toBe(403);
		expect(await errCode(res)).toBe("age_unconfirmed");
	});

	it("stores the chosen name and city label and shows them on /me", async () => {
		const u = await signedInUser();
		expect((await me(u.cookie)).tagalong).toEqual({
			opted_in: false,
			name: null,
			city: null,
			safety_acked: false,
			trusted: false,
			suspended: false,
		});
		const res = await postJson(
			"/tagalong/opt-in",
			{ confirm: true, name: "  Sam ", city: " Montréal " },
			u.cookie,
		);
		expect(res.status).toBe(200);
		const view = await me(u.cookie);
		expect(view.tagalong).toEqual({
			opted_in: true,
			name: "Sam",
			city: "Montréal",
			safety_acked: false,
			trusted: false,
			suspended: false,
		});
		expect(view.is_moderator).toBe(false);
	});

	it("requires confirm: true", async () => {
		const u = await signedInUser();
		for (const confirm of [false, undefined, "true"]) {
			const res = await postJson(
				"/tagalong/opt-in",
				{ confirm, name: "Sam", city: "Ottawa" },
				u.cookie,
			);
			expect(res.status).toBe(400);
		}
		expect((await me(u.cookie)).tagalong.opted_in).toBe(false);
	});

	it("refuses coordinates, addresses, postal codes and links as the city", async () => {
		const u = await signedInUser();
		for (const city of [
			"43.6532, -79.3832",
			"43.65,-79.38",
			"12 Main St",
			"M5V 2T6",
			"toronto.com",
			"",
			"x".repeat(81),
		]) {
			const res = await postJson(
				"/tagalong/opt-in",
				{ confirm: true, name: "Sam", city },
				u.cookie,
			);
			expect(res.status, city).toBe(400);
		}
		expect((await me(u.cookie)).tagalong.city).toBeNull();
	});

	it("refuses an empty, over-long or link-bearing name", async () => {
		const u = await signedInUser();
		for (const name of ["", "   ", "x".repeat(41), "sam@example.com", "www.sam.com"]) {
			const res = await postJson(
				"/tagalong/opt-in",
				{ confirm: true, name, city: "Ottawa" },
				u.cookie,
			);
			expect(res.status, name).toBe(400);
		}
	});

	it("is refused while suspended, and a suspended user stays suspended", async () => {
		const u = await tagalongUser();
		await suspend(u.id);
		const res = await postJson(
			"/tagalong/opt-in",
			{ confirm: true, name: "New", city: "Ottawa" },
			u.cookie,
		);
		expect(res.status).toBe(403);
		expect(await errCode(res)).toBe("tagalong_suspended");
		expect((await me(u.cookie)).tagalong.suspended).toBe(true);
	});
});

describe("Tagalong gates", () => {
	it("refuses member routes before opt-in (403 tagalong_opt_in_required)", async () => {
		const u = await signedInUser();
		const eventId = await makeEvent();
		await makeEventPlan(u.id, eventId);
		for (const res of [
			await call("/connections", { cookie: u.cookie }),
			await postJson(`/events/${eventId}/group/join`, {}, u.cookie),
			await postJson("/tagalong/safety-ack", {}, u.cookie),
			await call("/groups/anything", { cookie: u.cookie }),
		]) {
			expect(res.status).toBe(403);
			expect(await errCode(res)).toBe("tagalong_opt_in_required");
		}
	});

	it("refuses an under-18 account everywhere (403 age_unconfirmed)", async () => {
		const u = await signedInUser({ adult: false });
		for (const res of [
			await call("/connections", { cookie: u.cookie }),
			await call("/blocks", { cookie: u.cookie }),
			await call("/events/x/group", { cookie: u.cookie }),
		]) {
			expect(res.status).toBe(403);
			expect(await errCode(res)).toBe("age_unconfirmed");
		}
	});

	it("refuses a suspended user (403 tagalong_suspended)", async () => {
		const u = await tagalongUser();
		const { groupId } = await groupWith(u);
		await suspend(u.id);
		for (const res of [
			await call("/connections", { cookie: u.cookie }),
			await call(`/groups/${groupId}`, { cookie: u.cookie }),
			await call(`/groups/${groupId}/messages`, { cookie: u.cookie }),
			await postJson(`/groups/${groupId}/messages`, { body: "hi" }, u.cookie),
		]) {
			expect(res.status).toBe(403);
			expect(await errCode(res)).toBe("tagalong_suspended");
		}
	});

	it("signed-out requests are 401", async () => {
		for (const path of [
			"/connections",
			"/groups/x",
			"/groups/x/messages",
			"/blocks",
			"/mod/reports",
		])
			expect((await call(path)).status, path).toBe(401);
	});
});

describe("safety note and opt-out", () => {
	it("records the safety acknowledgement", async () => {
		const u = await tagalongUser();
		expect((await postJson("/tagalong/safety-ack", {}, u.cookie)).status).toBe(200);
		expect((await me(u.cookie)).tagalong.safety_acked).toBe(true);
	});

	it("opt-out leaves every group and closes connections, keeping messages", async () => {
		const a = await tagalongUser({ ack: true });
		const b = await tagalongUser({ ack: true });
		const { groupId } = await groupWith(a, b);
		const connId = await connect(a, b);
		const sent = await postJson(`/groups/${groupId}/messages`, { body: "see you there" }, a.cookie);
		const { message } = await sent.json<{ message: { id: string } }>();

		expect((await postJson("/tagalong/opt-out", {}, a.cookie)).status).toBe(200);
		expect((await me(a.cookie)).tagalong.opted_in).toBe(false);
		const members = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?",
		)
			.bind(a.id)
			.first<{ n: number }>();
		expect(members?.n).toBe(0);
		const conn = await env.DB.prepare("SELECT status FROM connections WHERE id = ?")
			.bind(connId)
			.first<{ status: string }>();
		expect(conn?.status).toBe("closed");
		const kept = await env.DB.prepare("SELECT body, deleted_at FROM messages WHERE id = ?")
			.bind(message.id)
			.first();
		expect(kept).toEqual({ body: "see you there", deleted_at: null });

		// Coming back does not restore the membership.
		await optIn(a, a.name);
		expect((await call(`/groups/${groupId}`, { cookie: a.cookie })).status).toBe(404);
		// And b no longer sees a in the group.
		const detail = await (await call(`/groups/${groupId}`, { cookie: b.cookie })).json<any>();
		expect(detail.members.map((m: { user_id: string }) => m.user_id)).toEqual([b.id]);
	});
});

describe("trust", () => {
	it("a new account is untrusted; one older than 7 days is trusted", async () => {
		const fresh = await tagalongUser();
		expect((await me(fresh.cookie)).tagalong.trusted).toBe(false);
		await makeOldAccount(fresh.id, 6);
		expect((await me(fresh.cookie)).tagalong.trusted).toBe(false);
		await makeOldAccount(fresh.id, 8);
		expect((await me(fresh.cookie)).tagalong.trusted).toBe(true);
	});

	it("only the configured moderator is reported as one on /me", async () => {
		const mod = await signedInUser({ id: MODERATOR_ID });
		expect((await me(mod.cookie)).is_moderator).toBe(true);
	});
});

describe("profiles", () => {
	it("are visible to a group-mate, 404 to a stranger, and show only name and city", async () => {
		const a = await tagalongUser({ city: "Hamilton" });
		const b = await tagalongUser();
		const stranger = await tagalongUser();
		const { groupId } = await groupWith(a, b);
		const res = await call(`/tagalong/users/${a.id}`, { cookie: b.cookie });
		expect(res.status).toBe(200);
		const profile = await res.json<any>();
		expect(profile).toMatchObject({
			user_id: a.id,
			name: a.name,
			city: "Hamilton",
			is_me: false,
			connection_status: null,
		});
		expect(profile.shared_groups.map((g: { group_id: string }) => g.group_id)).toEqual([groupId]);
		expect((await call(`/tagalong/users/${a.id}`, { cookie: stranger.cookie })).status).toBe(404);
		expect((await call(`/tagalong/users/no-such-user`, { cookie: b.cookie })).status).toBe(404);
	});

	it("my own profile is visible to me", async () => {
		const a = await tagalongUser();
		const profile = await (await call(`/tagalong/users/${a.id}`, { cookie: a.cookie })).json<any>();
		expect(profile).toMatchObject({ user_id: a.id, name: a.name, is_me: true });
	});

	it("are 404 once the other person opts out or is suspended", async () => {
		const a = await tagalongUser();
		const b = await tagalongUser();
		const c = await tagalongUser();
		await groupWith(a, b, c);
		await suspend(b.id);
		expect((await call(`/tagalong/users/${b.id}`, { cookie: a.cookie })).status).toBe(404);
		await postJson("/tagalong/opt-out", {}, c.cookie);
		expect((await call(`/tagalong/users/${c.id}`, { cookie: a.cookie })).status).toBe(404);
	});
});

describe("CSRF on Tagalong writes", () => {
	const writes = (groupId: string) =>
		[
			["/tagalong/opt-in", { confirm: true, name: "Sam", city: "Ottawa" }],
			["/tagalong/safety-ack", {}],
			["/tagalong/opt-out", {}],
			[`/groups/${groupId}/messages`, { body: "hi" }],
			[`/groups/${groupId}/leave`, {}],
			["/connections", { user_id: "x" }],
			["/blocks", { user_id: "x" }],
			["/reports", { target_type: "user", target_id: "x", reason: "spam" }],
			["/mod/reports/x/resolve", { action: "dismiss" }],
			["/mod/users/x/trust", {}],
		] as const;

	it("refuses a foreign or missing Origin (403 bad_origin)", async () => {
		const u = await tagalongUser();
		const { groupId } = await groupWith(u);
		for (const [path, body] of writes(groupId)) {
			const evil = await postJson(path, body, u.cookie, "https://evil.example");
			expect(evil.status, path).toBe(403);
			expect(await errCode(evil)).toBe("bad_origin");
			const none = await call(path, {
				method: "POST",
				cookie: u.cookie,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(none.status, path).toBe(403);
		}
		// Nothing changed.
		const members = await (await call(`/groups/${groupId}`, { cookie: u.cookie })).json<any>();
		expect(members.members).toHaveLength(1);
	});

	it("refuses a non-JSON body (415 json_only)", async () => {
		const u = await tagalongUser();
		const { groupId } = await groupWith(u);
		for (const [path, body] of writes(groupId)) {
			for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
				const res = await call(path, {
					method: "POST",
					cookie: u.cookie,
					headers: { "Content-Type": type, Origin: WEB },
					body: JSON.stringify(body),
				});
				expect(res.status, `${path} ${type}`).toBe(415);
				expect(await errCode(res)).toBe("json_only");
			}
		}
		const page = await (
			await call(`/groups/${groupId}/messages`, { cookie: u.cookie })
		).json<any>();
		expect(page.messages).toHaveLength(0);
	});
});

describe("GET /trips", () => {
	it("includes each saved trip's event_id (for the Who-else link)", async () => {
		const u = await signedInUser();
		const eventId = await makeEvent();
		const planId = await makeEventPlan(u.id, eventId);
		const trip = await env.DB.prepare("SELECT trip_request_id FROM plans WHERE id = ?")
			.bind(planId)
			.first<{ trip_request_id: string }>();
		await env.DB.prepare(
			`INSERT INTO saved_trips (user_id, plan_id, trip_request_id, latest_plan_id, currency)
			 VALUES (?, ?, ?, ?, 'CAD')`,
		)
			.bind(u.id, planId, trip?.trip_request_id, planId)
			.run();
		const trips = async () => {
			const res = await call("/trips", { cookie: u.cookie });
			expect(res.status).toBe(200);
			return (await res.json<{ trips: Record<string, unknown>[] }>()).trips;
		};
		expect(await trips()).toEqual([
			expect.objectContaining({
				plan_id: planId,
				event_id: eventId,
				group: { group_id: null, member_count: 0, joined: false },
			}),
		]);

		// Once a group exists, the row carries its summary.
		const other = await tagalongUser();
		const { groupId } = await groupWith(other);
		await env.DB.prepare(
			"UPDATE plans SET event_id = (SELECT event_id FROM event_groups WHERE id = ?) WHERE id = ?",
		)
			.bind(groupId, planId)
			.run();
		const [row] = await trips();
		expect(row?.group).toEqual({ group_id: groupId, member_count: 1, joined: false });

		// A trip with no event has no group at all.
		await env.DB.prepare("UPDATE plans SET event_id = NULL WHERE id = ?").bind(planId).run();
		const [none] = await trips();
		expect(none).toMatchObject({ event_id: null, group: null });
	});
});

describe("privacy: no email, home city or coordinates in any Tagalong response", () => {
	it("deep-scans every Tagalong JSON response and the /me tagalong block", async () => {
		const mod = await signedInUser({ id: MODERATOR_ID });
		const a = await tagalongUser({ ack: true, city: "Kingston" });
		const b = await tagalongUser({ ack: true, city: "Guelph" });
		const c = await tagalongUser();
		await setPrivateHome(mod.id);

		const rows = await env.DB.prepare(
			`SELECT email, display_name FROM users WHERE id IN (?, ?, ?, ?)`,
		)
			.bind(a.id, b.id, c.id, mod.id)
			.all<{ email: string; display_name: string }>();
		const secrets: unknown[] = [PRIVATE_HOME.city, PRIVATE_HOME.lat, PRIVATE_HOME.lng];
		for (const r of rows.results) secrets.push(r.email, r.display_name);
		expect(secrets).toHaveLength(3 + 8);

		const bodies: [string, unknown][] = [];
		const keep = async (label: string, res: Response | Promise<Response>) => {
			const r = await res;
			expect(r.status, label).toBeLessThan(300);
			const body = await r.json();
			bodies.push([label, body]);
			return body as any;
		};

		const eventId = await makeEvent();
		for (const u of [a, b, c]) await makeEventPlan(u.id, eventId);
		await keep("event group (before)", call(`/events/${eventId}/group`, { cookie: a.cookie }));
		const joined = await keep(
			"join",
			postJson(`/events/${eventId}/group/join`, { interest: "pre-game food" }, a.cookie),
		);
		const groupId = joined.group_id as string;
		await keep("join b", postJson(`/events/${eventId}/group/join`, {}, b.cookie));
		await keep("join c", postJson(`/events/${eventId}/group/join`, {}, c.cookie));
		await keep(
			"interest",
			postJson(`/groups/${groupId}/interest`, { interest: "rides" }, b.cookie),
		);
		await keep("group detail", call(`/groups/${groupId}`, { cookie: a.cookie }));
		const sent = await keep(
			"send",
			postJson(`/groups/${groupId}/messages`, { body: "hello" }, a.cookie),
		);
		await keep("messages", call(`/groups/${groupId}/messages`, { cookie: b.cookie }));
		await keep("profile", call(`/tagalong/users/${a.id}`, { cookie: b.cookie }));
		const asked = await keep("connect", postJson("/connections", { user_id: b.id }, a.cookie));
		await keep("connections", call("/connections", { cookie: b.cookie }));
		await keep("accept", postJson(`/connections/${asked.connection.id}/accept`, {}, b.cookie));
		await keep(
			"dm send",
			postJson(`/dms/${asked.connection.id}/messages`, { body: "hey" }, b.cookie),
		);
		await keep("dm list", call(`/dms/${asked.connection.id}/messages`, { cookie: a.cookie }));
		await keep(
			"report msg",
			postJson(
				"/reports",
				{ target_type: "message", target_id: sent.message.id, reason: "spam" },
				b.cookie,
			),
		);
		await keep(
			"report user",
			postJson("/reports", { target_type: "user", target_id: c.id, reason: "other" }, a.cookie),
		);
		await keep("block", postJson("/blocks", { user_id: c.id }, b.cookie));
		await keep("blocks", call("/blocks", { cookie: b.cookie }));
		const queue = await keep("mod queue", call("/mod/reports?status=open", { cookie: mod.cookie }));
		expect(queue.reports.length).toBeGreaterThanOrEqual(2);
		await keep(
			"mod resolve",
			postJson(`/mod/reports/${queue.reports[0].id}/resolve`, { action: "dismiss" }, mod.cookie),
		);
		await keep("mod resolved", call("/mod/reports?status=resolved", { cookie: mod.cookie }));
		await keep("trust", postJson(`/mod/users/${c.id}/trust`, {}, mod.cookie));
		await keep("safety-ack", postJson("/tagalong/safety-ack", {}, a.cookie));
		await keep(
			"opt-in",
			postJson("/tagalong/opt-in", { confirm: true, name: "Al", city: "Kingston" }, a.cookie),
		);
		await keep("leave", postJson(`/groups/${groupId}/leave`, {}, c.cookie));
		await keep("close", postJson(`/connections/${asked.connection.id}/close`, {}, a.cookie));
		await keep("unblock", postJson(`/blocks/${c.id}/remove`, {}, b.cookie));
		await keep("opt-out", postJson("/tagalong/opt-out", {}, b.cookie));
		for (const u of [a, b, mod]) {
			const view = await (await call("/me", { cookie: u.cookie })).json<any>();
			bodies.push(["/me tagalong", { tagalong: view.tagalong, is_moderator: view.is_moderator }]);
		}

		const leaks = bodies.flatMap(([label, body]) =>
			findPrivate(body, secrets).map((l) => `${label}: ${l}`),
		);
		expect(leaks).toEqual([]);
		// Control: the scanner does catch the user's own account fields on /me.
		const fullMe = await (await call("/me", { cookie: a.cookie })).json();
		expect(findPrivate(fullMe, secrets)).toEqual(
			expect.arrayContaining(["$.email", "$.home_city"]),
		);
	});
});
