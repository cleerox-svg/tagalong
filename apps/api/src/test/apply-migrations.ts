import { applyD1Migrations, env } from "cloudflare:test";

// Runs before the tests in each file, against the real migration SQL.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
