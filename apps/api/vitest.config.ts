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
						// Test-only stand-ins for the Worker secrets. Every outbound
						// provider call is mocked in the tests, so none is ever sent.
						SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
						GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
						GOOGLE_CLIENT_SECRET: "test-google-secret",
						ANTHROPIC_API_KEY: "test-anthropic-key",
						TICKETMASTER_API_KEY: "test-tm-key",
						GOOGLE_MAPS_API_KEY: "test-maps-key",
						EVENTBRITE_TOKEN: "test-eventbrite-token",
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
