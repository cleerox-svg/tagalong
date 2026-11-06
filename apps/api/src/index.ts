import { Hono } from "hono";
import { auth } from "./auth/routes.js";
import { errorBody, HttpError, sendError, type AppEnv } from "./lib/http.js";
import { corsMiddleware } from "./lib/security.js";
import { health } from "./routes/health.js";
import { plans } from "./routes/plans.js";
import { trips } from "./routes/trips.js";
import { checkSavedTrips } from "./planning/alerts.js";

const app = new Hono<AppEnv>();

app.use("*", corsMiddleware);

// Public.
app.route("/", health);
// Sign-in, session, profile.
app.route("/", auth);
// Signed in: Budgetrip.
app.route("/", plans);
// Signed in: saved trips and sharing. GET /shared/:token is public.
app.route("/", trips);

app.notFound((c) => c.json(errorBody("not_found", "No such route."), 404));

app.onError((err, c) => {
	if (err instanceof HttpError) return sendError(c, err);
	console.error("unhandled error", err);
	return c.json(errorBody("internal", "Something went wrong."), 500);
});

export { app };

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
