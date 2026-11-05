import { Hono } from "hono";
import { health } from "./routes/health.js";

const app = new Hono<{ Bindings: Env }>();

// Public.
app.route("/", health);

app.notFound((c) => c.json({ error: { code: "not_found", message: "No such route." } }, 404));

app.onError((err, c) => {
	console.error("unhandled error", err);
	return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
});

export default app;
