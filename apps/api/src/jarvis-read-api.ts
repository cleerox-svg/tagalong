import { WorkerEntrypoint } from "cloudflare:workers";
import {
	JARVIS_CONTRACT_VERSION,
	readUpcomingTripsForJarvis,
	type JarvisUpcomingTrips,
} from "./lib/jarvis-read.js";

/**
 * Tagalong's read-only API for Jarvis, reached ONLY through a Cloudflare
 * service binding (`entrypoint: "JarvisReadApi"`) from a Worker on the same
 * account. There is no HTTP route to it.
 *
 * Every public method here is callable over RPC, so this class has exactly
 * two, both read-only, and no `fetch`. Do not add a member without treating it
 * as a new, public, cross-Worker API (contract v2, `hold`, security review).
 */
export class JarvisReadApi extends WorkerEntrypoint<Env> {
	ping(): { app: "tagalong"; contractVersion: typeof JARVIS_CONTRACT_VERSION } {
		return { app: "tagalong", contractVersion: JARVIS_CONTRACT_VERSION };
	}

	/**
	 * Bad input or an unknown / disallowed user gets `{ trips: [] }`. An
	 * internal failure rejects with a fixed `tagalong_unavailable`: the real
	 * error (which may carry SQL or schema text) is logged here, without the
	 * email, and never crosses the RPC boundary; an outage never reads as "no
	 * trips".
	 */
	async getUpcomingTrips(userEmail: unknown): Promise<JarvisUpcomingTrips> {
		try {
			return await readUpcomingTripsForJarvis(this.env, userEmail);
		} catch (err) {
			console.error("jarvis read failed", err instanceof Error ? err.message : "unknown error");
			throw new Error("tagalong_unavailable");
		}
	}
}
