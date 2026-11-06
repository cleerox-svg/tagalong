/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API origin is public configuration, not a secret. Nothing secret is ever
// compiled into this bundle (spec §2.7); CI greps the build to check.
export default defineConfig(({ mode }) => ({
	plugins: [react()],
	define: {
		__API_BASE__: JSON.stringify(
			mode === "production" ? "https://tagalong-api.averrow.com" : "http://localhost:8787",
		),
	},
	server: { port: 5173, strictPort: true },
	test: { include: ["src/**/*.test.ts"] },
}));
