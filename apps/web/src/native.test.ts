import { PKCE_VERIFIER_RE } from "@tagalong/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capacitor plugins, mocked: the tests drive the listeners by hand.
const listeners = new Map<string, (e: unknown) => void>();
const store = new Map<string, string>();
const browserOpen = vi.fn(async (_o: { url: string }) => undefined);
const browserClose = vi.fn(async () => undefined);

vi.mock("@capacitor/app", () => ({
	App: {
		addListener: vi.fn(async (name: string, fn: (e: unknown) => void) => {
			listeners.set(`app:${name}`, fn);
			return { remove: async () => listeners.delete(`app:${name}`) };
		}),
	},
}));
vi.mock("@capacitor/browser", () => ({
	Browser: {
		open: (o: { url: string }) => browserOpen(o),
		close: () => browserClose(),
		addListener: vi.fn(async (name: string, fn: (e: unknown) => void) => {
			listeners.set(`browser:${name}`, fn);
			return { remove: async () => listeners.delete(`browser:${name}`) };
		}),
	},
}));
vi.mock("capacitor-secure-storage-plugin", () => ({
	SecureStoragePlugin: {
		get: async ({ key }: { key: string }) => {
			const value = store.get(key);
			if (value === undefined) throw new Error("Item with given key does not exist");
			return { value };
		},
		set: async ({ key, value }: { key: string; value: string }) => {
			store.set(key, value);
			return { value: true };
		},
		remove: async ({ key }: { key: string }) => ({ value: store.delete(key) }),
	},
}));

const {
	AUTH_CALLBACK,
	base64url,
	clearNativeToken,
	createVerifier,
	getNativeToken,
	handleAuthUrl,
	isNative,
	nativeSignIn,
	parseAuthCallback,
	pkceChallenge,
	resetNativeStateForTests,
	safeTapPath,
	signInErrorMessage,
} = await import("./native.js");
const { withTicket } = await import("./chat.js");

const CODE = "A".repeat(20) + "b-_9".repeat(5); // 40 base64url chars

function setNative(platform: "ios" | "android" | null) {
	const g = globalThis as { Capacitor?: unknown };
	if (platform === null) delete g.Capacitor;
	else g.Capacitor = { isNativePlatform: () => true, getPlatform: () => platform };
}

beforeEach(() => {
	listeners.clear();
	store.clear();
	browserOpen.mockClear();
	browserClose.mockClear();
	resetNativeStateForTests();
});
afterEach(() => {
	setNative(null);
	vi.unstubAllGlobals();
});

describe("PKCE (RFC 7636)", () => {
	it("matches the appendix B S256 test vector", async () => {
		expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});

	it("encodes the appendix B octets as the appendix B verifier", () => {
		const octets = [
			116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
			105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
		];
		expect(base64url(new Uint8Array(octets))).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
		expect(base64url(new Uint8Array([251, 255]))).toBe("-_8");
	});

	it("makes 43-char unreserved verifiers, different each time", () => {
		const a = createVerifier();
		const b = createVerifier();
		expect(a).toHaveLength(43);
		expect(a).toMatch(PKCE_VERIFIER_RE);
		expect(a).not.toBe(b);
	});

	it("challenges are unpadded base64url", async () => {
		const c = await pkceChallenge(createVerifier());
		expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});

describe("parseAuthCallback", () => {
	it("reads a valid code", () => {
		expect(parseAuthCallback(`${AUTH_CALLBACK}?code=${CODE}`)).toEqual({
			kind: "code",
			code: CODE,
		});
	});

	it("reads an error code, never echoing anything odd", () => {
		expect(parseAuthCallback(`${AUTH_CALLBACK}?error=cancelled`)).toEqual({
			kind: "error",
			error: "cancelled",
		});
		expect(parseAuthCallback(`${AUTH_CALLBACK}?error=%3Cscript%3E`)).toEqual({
			kind: "error",
			error: "unknown",
		});
	});

	it("ignores URLs that aren't the sign-in callback", () => {
		for (const url of [
			"com.averrow.budgetrip://chat/dm/1",
			`com.averrow.budgetrip://auth/callbackx?code=${CODE}`,
			`com.averrow.budgetrip://auth/callback/extra?code=${CODE}`,
			`https://evil.example/com.averrow.budgetrip://auth/callback?code=${CODE}`,
			`other.app://auth/callback?code=${CODE}`,
			"",
		])
			expect(parseAuthCallback(url), url).toBeNull();
	});

	it("rejects malformed, duplicated or mixed parameters", () => {
		for (const q of [
			"",
			"?code=short",
			`?code=${CODE}%20`,
			`?code=${CODE}&code=${CODE}`,
			`?code=${CODE}&error=cancelled`,
			"?error=a&error=b",
			`?code=${"A".repeat(129)}`,
		])
			expect(parseAuthCallback(`${AUTH_CALLBACK}${q}`), q).toEqual({ kind: "invalid" });
	});

	it("has a plain message for each failure", () => {
		expect(signInErrorMessage("cancelled")).toMatch(/cancelled/);
		expect(signInErrorMessage("whatever")).toBe("We couldn't sign you in. Try again.");
	});
});

describe("safeTapPath", () => {
	it("allows in-app paths only", () => {
		expect(safeTapPath({ kind: "dm", path: "/dm/abc" })).toBe("/dm/abc");
		expect(safeTapPath({ path: "/plans/1?x=1" })).toBe("/plans/1?x=1");
		for (const path of [
			"//evil.example",
			"/\\evil.example",
			"https://evil.example",
			"javascript:alert(1)",
			"dm/abc",
			"/a b",
			"",
			42,
			undefined,
		])
			expect(safeTapPath({ path }), String(path)).toBeNull();
		expect(safeTapPath(null)).toBeNull();
		expect(safeTapPath("/dm/abc")).toBeNull();
	});
});

describe("withTicket", () => {
	it("adds the ticket as a query parameter, encoded", () => {
		expect(withTicket("wss://api/chat/dm/1/ws", "a+b/c")).toBe(
			"wss://api/chat/dm/1/ws?ticket=a%2Bb%2Fc",
		);
		expect(withTicket("wss://api/ws?x=1", "t")).toBe("wss://api/ws?x=1&ticket=t");
	});
});

describe("native detection and token", () => {
	it("is off in a browser, and never touches secure storage there", async () => {
		expect(isNative()).toBe(false);
		store.set("budgetrip.session", JSON.stringify({ token: "t", expires_at: "2999-01-01" }));
		expect(await getNativeToken()).toBeNull();
	});

	it("reads the token from secure storage once, then from memory", async () => {
		setNative("ios");
		store.set("budgetrip.session", JSON.stringify({ token: "tok", expires_at: "2999-01-01" }));
		expect(await getNativeToken()).toBe("tok");
		store.clear();
		expect(await getNativeToken()).toBe("tok");
	});

	it("drops an expired token", async () => {
		setNative("android");
		store.set("budgetrip.session", JSON.stringify({ token: "old", expires_at: "2000-01-01" }));
		expect(await getNativeToken()).toBeNull();
		expect(store.has("budgetrip.session")).toBe(false);
	});

	it("a late 401 for an old token doesn't clear a newer one", async () => {
		setNative("ios");
		store.set("budgetrip.session", JSON.stringify({ token: "new", expires_at: "2999-01-01" }));
		expect(await getNativeToken()).toBe("new");
		await clearNativeToken("old");
		expect(await getNativeToken()).toBe("new");
		await clearNativeToken("new");
		expect(await getNativeToken()).toBeNull();
	});
});

describe("nativeSignIn", () => {
	it("ignores a callback when no sign-in is pending", async () => {
		setNative("ios");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await handleAuthUrl(`${AUTH_CALLBACK}?code=${CODE}`);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await getNativeToken()).toBeNull();
	});

	it("opens the browser with an S256 challenge, exchanges the code with the verifier, stores the token", async () => {
		setNative("ios");
		const fetchMock = vi.fn(
			async (_url: string, _init: RequestInit) =>
				new Response(JSON.stringify({ token: "sess", expires_at: "2999-01-01T00:00:00Z" }), {
					status: 200,
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const done = nativeSignIn();
		await vi.waitFor(() => expect(browserOpen).toHaveBeenCalled());
		const opened = new URL(browserOpen.mock.calls[0]?.[0].url ?? "");
		expect(opened.pathname).toBe("/auth/google/start");
		expect(opened.searchParams.get("native")).toBe("1");
		const challenge = opened.searchParams.get("code_challenge") ?? "";
		expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

		// Some other deep link first: ignored, sign-in still pending.
		listeners.get("app:appUrlOpen")?.({ url: "com.averrow.budgetrip://dm/1" });
		expect(fetchMock).not.toHaveBeenCalled();

		listeners.get("app:appUrlOpen")?.({ url: `${AUTH_CALLBACK}?code=${CODE}` });
		await done;

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toMatch(/\/auth\/native\/exchange$/);
		expect(init?.method).toBe("POST");
		expect(init?.credentials).toBe("omit");
		const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string };
		expect(body.code).toBe(CODE);
		expect(await pkceChallenge(body.code_verifier)).toBe(challenge);
		expect(browserClose).toHaveBeenCalled();
		expect(await getNativeToken()).toBe("sess");
		expect(JSON.parse(store.get("budgetrip.session") ?? "{}")).toMatchObject({ token: "sess" });

		// A replayed callback after completion is ignored.
		fetchMock.mockClear();
		await handleAuthUrl(`${AUTH_CALLBACK}?code=${CODE}`);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects with a safe message on an error callback or a failed exchange", async () => {
		setNative("android");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 400 })),
		);

		const a = nativeSignIn();
		await vi.waitFor(() => expect(listeners.has("app:appUrlOpen")).toBe(true));
		listeners.get("app:appUrlOpen")?.({ url: `${AUTH_CALLBACK}?error=cancelled` });
		await expect(a).rejects.toThrow("Sign-in was cancelled.");

		const b = nativeSignIn();
		await vi.waitFor(() => expect(listeners.has("app:appUrlOpen")).toBe(true));
		listeners.get("app:appUrlOpen")?.({ url: `${AUTH_CALLBACK}?code=${CODE}` });
		await expect(b).rejects.toThrow("We couldn't sign you in. Try again.");
		expect(await getNativeToken()).toBeNull();
	});
});
