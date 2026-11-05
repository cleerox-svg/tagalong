import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			// The SAME root migrations directory the Worker deploys from, so
			// tests run against the real schema, not a hand-kept fixture.
			const migrations = await readD1Migrations(path.join(import.meta.dirname, "../../migrations"));

			return {
				// Bindings come from the real wrangler.jsonc. Miniflare simulates
				// D1 locally; the production database is never contacted.
				wrangler: { configPath: "./wrangler.jsonc" },
				remoteBindings: false,
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
					},
				},
			};
		}),
	],
	test: {
		setupFiles: ["./src/test/apply-migrations.ts"],
		include: ["src/**/*.test.ts"],
	},
});
