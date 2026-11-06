import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type AppEnv = { Bindings: Env; Variables: { userId: string } };

export class HttpError extends Error {
	constructor(
		readonly status: ContentfulStatusCode,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export function errorBody(code: string, message: string, details?: unknown) {
	return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function sendError(c: Context, err: HttpError) {
	return c.json(errorBody(err.code, err.message, err.details), err.status);
}

/** Parses a JSON body, turning malformed JSON into a 400 rather than a 500. */
export async function readJson(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new HttpError(400, "bad_json", "Request body must be JSON.");
	}
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
