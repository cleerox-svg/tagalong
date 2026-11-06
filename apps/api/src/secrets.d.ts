// Worker secrets. Set with `wrangler secret put <NAME>` (see docs/SETUP.md);
// never in wrangler.jsonc, so `wrangler types` cannot see them. Declared here
// rather than in the generated worker-configuration.d.ts, which is never
// hand-edited.
interface WorkerSecrets {
	/** HMAC key for the session cookie. 32+ random bytes. */
	SESSION_SECRET: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	ANTHROPIC_API_KEY: string;
	TICKETMASTER_API_KEY: string;
	/** Google Maps Platform key with the Places API (New) enabled. */
	GOOGLE_MAPS_API_KEY: string;
	/**
	 * Phase 2 live prices. Optional: without them those lines stay labelled
	 * estimates. A Duffel test token (duffel_test_...) returns sandbox offers.
	 */
	DUFFEL_ACCESS_TOKEN?: string;
	BOOKING_API_TOKEN?: string;
	BOOKING_AFFILIATE_ID?: string;
	/** Phase 3 price-drop emails. Optional: without it alerts are shown in the app only. */
	RESEND_API_KEY?: string;
}

declare namespace Cloudflare {
	interface Env extends WorkerSecrets {}
}
interface Env extends WorkerSecrets {}
