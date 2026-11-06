import { Hono } from "hono";
import { auth } from "./auth/routes.js";
import { errorBody, HttpError, sendError, type AppEnv } from "./lib/http.js";
import { corsMiddleware } from "./lib/security.js";
import { health } from "./routes/health.js";
import { plans } from "./routes/plans.js";

const app = new Hono<AppEnv>();

app.use("*", corsMiddleware);

// Public.
app.route("/", health);
// Sign-in, session, profile.
app.route("/", auth);
// Signed in: Budgetrip.
app.route("/", plans);

app.notFound((c) => c.json(errorBody("not_found", "No such route."), 404));

app.onError((err, c) => {
	if (err instanceof HttpError) return sendError(c, err);
	console.error("unhandled error", err);
	return c.json(errorBody("internal", "Something went wrong."), 500);
});

export default app;
