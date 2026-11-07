/**
 * Phase 5 (BUILD_SPEC §6): the moderation queue. Moderators are listed in the
 * MODERATOR_USER_IDS var (not a secret); empty means nobody (403 for all).
 */
import { Hono } from "hono";
import { ModResolveSchema } from "@tagalong/shared";
import { requireAdult, requireUser } from "../auth/session.js";
import { deferOf } from "../chat/notify.js";
import { HttpError, readJson } from "../lib/http.js";
import { requireTrustedWrite } from "../lib/security.js";
import { requireModerator, type TgEnv } from "../tagalong/access.js";
import { listReports, resolveReport, trustUser } from "../tagalong/reports.js";

export const moderation = new Hono<TgEnv>();

const mod = [requireTrustedWrite, requireUser, requireAdult, requireModerator] as const;

moderation.get("/mod/reports", ...mod, async (c) => {
	const status = c.req.query("status") ?? "open";
	if (status !== "open" && status !== "resolved")
		throw new HttpError(400, "invalid", "status is open or resolved.");
	c.header("Cache-Control", "no-store");
	return c.json({ reports: await listReports(c.env.DB, status) });
});

moderation.post("/mod/reports/:id/resolve", ...mod, async (c) => {
	const body = ModResolveSchema.safeParse(await readJson(c));
	if (!body.success)
		throw new HttpError(
			400,
			"invalid",
			"action is dismiss, remove_message or suspend_user.",
			body.error.issues,
		);
	const report = await resolveReport(
		c.env,
		deferOf(c),
		c.req.param("id"),
		c.get("userId"),
		body.data.action,
	);
	return c.json({ report });
});

/** Lifts the new-account limits for a user. */
moderation.post("/mod/users/:id/trust", ...mod, async (c) => {
	await trustUser(c.env.DB, c.req.param("id"));
	return c.json({ trusted: true });
});
