import { Hono } from "hono";
import { auth } from "./auth/routes.js";
import { errorBody, HttpError, sendError, type AppEnv } from "./lib/http.js";
import { corsMiddleware } from "./lib/security.js";
import { health } from "./routes/health.js";
import { events } from "./routes/events.js";
import { plans } from "./routes/plans.js";
import { trips } from "./routes/trips.js";
import { push } from "./routes/push.js";
import { chat } from "./routes/chat.js";
import { groups } from "./routes/groups.js";
import { moderation } from "./routes/moderation.js";
import { social } from "./routes/social.js";
import { tagalong } from "./routes/tagalong.js";
import { checkSavedTrips } from "./planning/alerts.js";

const app = new Hono<AppEnv>();

app.use("*", corsMiddleware);

// Public.
app.route("/", health);
// Sign-in, session, profile.
app.route("/", auth);
// Signed in: Budgetrip.
app.route("/", plans);
// Signed in: pasted event links and category browse.
app.route("/", events);
// Signed in: saved trips and sharing. GET /shared/:token is public.
app.route("/", trips);
// Signed in, 18+: Tagalong (phase 5). Opt-in, groups and group chat,
// connections and DMs, blocks and reports, the chat socket, moderation.
app.route("/", tagalong);
app.route("/", groups);
app.route("/", social);
app.route("/", chat);
app.route("/", moderation);
// Signed in: push devices and notification preferences (phase 6).
app.route("/", push);

app.notFound((c) => c.json(errorBody("not_found", "No such route."), 404));

app.onError((err, c) => {
	if (err instanceof HttpError) return sendError(c, err);
	console.error("unhandled error", err);
	return c.json(errorBody("internal", "Something went wrong."), 500);
});

export { app };
// Durable Object class for wrangler.jsonc durable_objects.bindings (CHAT_ROOM).
export { ChatRoom } from "./chat/room.js";

export default {
	fetch: app.fetch,
	// Cron Trigger (wrangler.jsonc): scheduled price checks for saved trips.
	scheduled(_controller, env, ctx) {
		ctx.waitUntil(
			checkSavedTrips(env).then(
				(r) => console.log("saved-trip price check", r),
				(err) => console.error("saved-trip price check failed", err),
			),
		);
	},
} satisfies ExportedHandler<Env>;
