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

// The FirebaseMessaging plugin, as registered through @capacitor/core.
const fm = {
	checkPermissions: vi.fn(async () => ({ receive: "granted" as string })),
	requestPermissions: vi.fn(async () => ({ receive: "granted" as string })),
	getToken: vi.fn(async () => ({ token: "fcm-1" })),
	addListener: vi.fn(async (name: string, fn: (e: unknown) => void) => {
		listeners.set(`fm:${name}`, fn);
		return { remove: async () => undefined };
	}),
};
vi.mock("@capacitor/core", () => ({ registerPlugin: () => fm }));
const navigateMock = vi.fn();
vi.mock("./router.js", () => ({ navigate: (p: string) => navigateMock(p) }));

const {
	AUTH_CALLBACK,
	base64url,
	clearNativeToken,
	createVerifier,
	enablePush,
	getNativeToken,
	handleAuthUrl,
	isNative,
	nativeAfterAccountDeleted,
	nativeSignIn,
	nativeSignOut,
	parseAuthCallback,
	pkceChallenge,
	pushPermission,
	registerDevice,
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
	navigateMock.mockClear();
	fm.checkPermissions.mockReset().mockResolvedValue({ receive: "granted" });
	fm.requestPermissions.mockReset().mockResolvedValue({ receive: "granted" });
	fm.getToken.mockReset().mockResolvedValue({ token: "fcm-1" });
	fm.addListener.mockClear();
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

	it("is exactly the HTTPS app-callback link on our domain", () => {
		expect(AUTH_CALLBACK).toBe("https://tagalong.averrow.com/auth/app-callback");
		expect(parseAuthCallback(`${AUTH_CALLBACK}?code=${CODE}#frag`)).toEqual({
			kind: "code",
			code: CODE,
		});
	});

	it("ignores URLs that aren't the sign-in callback", () => {
		for (const url of [
			// The old custom scheme is gone: any app could claim it.
			`com.averrow.budgetrip://auth/callback?code=${CODE}`,
			"com.averrow.budgetrip://chat/dm/1",
			// Other hosts, schemes and ports.
			`http://tagalong.averrow.com/auth/app-callback?code=${CODE}`,
			`https://evil.example/auth/app-callback?code=${CODE}`,
			`https://tagalong.averrow.com.evil.example/auth/app-callback?code=${CODE}`,
			`https://evil.tagalong.averrow.com/auth/app-callback?code=${CODE}`,
			`https://tagalong.averrow.com:8443/auth/app-callback?code=${CODE}`,
			`https://user@tagalong.averrow.com/auth/app-callback?code=${CODE}`,
			`https://TAGALONG.averrow.com/auth/app-callback?code=${CODE}`,
			`https://evil.example/https://tagalong.averrow.com/auth/app-callback?code=${CODE}`,
			// Other paths, extra segments, trailing slash, look-alikes.
			`https://tagalong.averrow.com/auth/app-callbackx?code=${CODE}`,
			`https://tagalong.averrow.com/auth/app-callback/?code=${CODE}`,
			`https://tagalong.averrow.com/auth/app-callback/extra?code=${CODE}`,
			`https://tagalong.averrow.com/auth/app-callback/../app-callback?code=${CODE}`,
			`https://tagalong.averrow.com/auth/callback?code=${CODE}`,
			`https://tagalong.averrow.com/x/auth/app-callback?code=${CODE}`,
			"https://tagalong.averrow.com/s/abc",
			`other.app://auth/app-callback?code=${CODE}`,
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

		const done = nativeSignIn("google");
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

		const a = nativeSignIn("google");
		await vi.waitFor(() => expect(listeners.has("app:appUrlOpen")).toBe(true));
		listeners.get("app:appUrlOpen")?.({ url: `${AUTH_CALLBACK}?error=cancelled` });
		await expect(a).rejects.toThrow("Sign-in was cancelled.");

		const b = nativeSignIn("google");
		await vi.waitFor(() => expect(listeners.has("app:appUrlOpen")).toBe(true));
		listeners.get("app:appUrlOpen")?.({ url: `${AUTH_CALLBACK}?code=${CODE}` });
		await expect(b).rejects.toThrow("We couldn't sign you in. Try again.");
		expect(await getNativeToken()).toBeNull();
	});
});

describe("nativeSignIn with Apple", () => {
	it("opens the Apple start URL with an S256 challenge and exchanges the same way", async () => {
		setNative("ios");
		const fetchMock = vi.fn(
			async (_url: string, _init: RequestInit) =>
				new Response(JSON.stringify({ token: "sess-a", expires_at: "2999-01-01T00:00:00Z" }), {
					status: 200,
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const done = nativeSignIn("apple");
		await vi.waitFor(() => expect(browserOpen).toHaveBeenCalled());
		const opened = new URL(browserOpen.mock.calls[0]?.[0].url ?? "");
		expect(opened.pathname).toBe("/auth/apple/start");
		expect(opened.searchParams.get("native")).toBe("1");
		const challenge = opened.searchParams.get("code_challenge") ?? "";
		expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

		// The old custom-scheme callback is not ours any more: ignored.
		listeners.get("app:appUrlOpen")?.({
			url: `com.averrow.budgetrip://auth/callback?code=${CODE}`,
		});
		expect(fetchMock).not.toHaveBeenCalled();

		listeners.get("app:appUrlOpen")?.({ url: `${AUTH_CALLBACK}?code=${CODE}` });
		await done;
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
			code: string;
			code_verifier: string;
		};
		expect(body.code).toBe(CODE);
		expect(await pkceChallenge(body.code_verifier)).toBe(challenge);
		expect(await getNativeToken()).toBe("sess-a");
	});
});

describe("nativeAfterAccountDeleted", () => {
	it("forgets the session and push tokens without calling the API", async () => {
		setNative("android");
		store.set(
			"budgetrip.session",
			JSON.stringify({ token: "sess", expires_at: "2999-01-01T00:00:00Z" }),
		);
		store.set("budgetrip.push-token", "fcm-1");
		expect(await getNativeToken()).toBe("sess"); // now cached in memory too
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await nativeAfterAccountDeleted();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(store.has("budgetrip.session")).toBe(false);
		expect(store.has("budgetrip.push-token")).toBe(false);
		expect(await getNativeToken()).toBeNull();
		// A later sign-out has no push token left to unregister.
		await nativeSignOut().catch(() => undefined);
		expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/push/devices/unregister"))).toBe(
			false,
		);
	});

	it("cancels a sign-in in progress", async () => {
		setNative("ios");
		vi.stubGlobal("fetch", vi.fn());
		const pendingSignIn = nativeSignIn("google");
		await vi.waitFor(() => expect(browserOpen).toHaveBeenCalled());
		await nativeAfterAccountDeleted();
		await expect(pendingSignIn).rejects.toThrow("Sign-in was cancelled.");
	});
});

describe("push", () => {
	const SESSION = JSON.stringify({ token: "sess", expires_at: "2999-01-01T00:00:00Z" });
	type Call = [string, RequestInit];
	const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls as Call[];
	const signedIn = () => store.set("budgetrip.session", SESSION);
	const fetchWith = (status: number) => {
		const f = vi.fn(async (_url: string, _init: RequestInit) =>
			status === 204 ? new Response(null, { status }) : new Response("{}", { status }),
		);
		vi.stubGlobal("fetch", f);
		return f;
	};

	it("registerDevice posts {platform, token} with the bearer and remembers the token", async () => {
		setNative("android");
		signedIn();
		const f = fetchWith(204);
		expect(await registerDevice("fcm-1")).toBe(true);
		const [url, init] = calls(f)[0] ?? [];
		expect(url).toMatch(/\/push\/devices$/);
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sess");
		expect(JSON.parse(String(init?.body))).toEqual({ platform: "android", token: "fcm-1" });
		expect(store.get("budgetrip.push-token")).toBe("fcm-1");
	});

	it("registerDevice throws on a non-OK response and remembers nothing", async () => {
		setNative("ios");
		signedIn();
		fetchWith(429);
		await expect(registerDevice("fcm-1")).rejects.toMatchObject({ status: 429 });
		expect(store.has("budgetrip.push-token")).toBe(false);
	});

	it("registerDevice does nothing when signed out", async () => {
		setNative("ios");
		const f = fetchWith(204);
		expect(await registerDevice("fcm-1")).toBe(false);
		expect(f).not.toHaveBeenCalled();
	});

	it("unregisters the stored push token on sign-out after a relaunch, then forgets both", async () => {
		setNative("ios");
		signedIn();
		fetchWith(204);
		await registerDevice("fcm-1");
		resetNativeStateForTests(); // relaunch: nothing in memory

		const f = fetchWith(204);
		await nativeSignOut();
		const unregister = calls(f).find(([u]) => u.endsWith("/push/devices/unregister"));
		expect(unregister).toBeDefined();
		expect(JSON.parse(String(unregister?.[1].body))).toEqual({ token: "fcm-1" });
		expect(new Headers(unregister?.[1].headers).get("Authorization")).toBe("Bearer sess");
		expect(store.has("budgetrip.session")).toBe(false);
		expect(store.has("budgetrip.push-token")).toBe(false);
		expect(await getNativeToken()).toBeNull();
	});

	it("sign-out still clears everything when unregistering fails, and logs no token", async () => {
		setNative("android");
		signedIn();
		store.set("budgetrip.push-token", "fcm-secret");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("offline");
			}),
		);
		await nativeSignOut();
		expect(store.size).toBe(0);
		expect(warn).toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain("fcm-secret");
		warn.mockRestore();
	});

	it("enablePush: unsupported in a browser or without the plugin", async () => {
		expect(await enablePush()).toBe("unsupported");
		setNative("ios");
		fm.checkPermissions.mockRejectedValue(
			Object.assign(new Error("not implemented"), { code: "UNIMPLEMENTED" }),
		);
		expect(await pushPermission()).toBe("unsupported");
		expect(await enablePush()).toBe("unsupported");
	});

	it("enablePush: failed when registration is refused, with a warning that has no token", async () => {
		setNative("ios");
		signedIn();
		fetchWith(500);
		fm.getToken.mockResolvedValue({ token: "fcm-secret" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(await enablePush()).toBe("failed");
		expect(warn).toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain("fcm-secret");
		warn.mockRestore();
	});

	it("enablePush: failed when the plugin errors, granted when it all works", async () => {
		setNative("android");
		signedIn();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		fm.getToken.mockRejectedValueOnce(new Error("FCM unavailable"));
		expect(await enablePush()).toBe("failed");
		fetchWith(204);
		expect(await enablePush()).toBe("granted");
		expect(store.get("budgetrip.push-token")).toBe("fcm-1");
		warn.mockRestore();
	});

	it("enablePush asks only when undecided and returns the answer", async () => {
		setNative("ios");
		fm.checkPermissions.mockResolvedValue({ receive: "prompt" });
		fm.requestPermissions.mockResolvedValue({ receive: "denied" });
		expect(await enablePush()).toBe("denied");
		expect(fm.requestPermissions).toHaveBeenCalledTimes(1);
		expect(fm.getToken).not.toHaveBeenCalled();
	});

	it("a notification tap navigates only to a safe in-app path", async () => {
		setNative("ios");
		signedIn();
		fetchWith(204);
		await enablePush();
		const tap = listeners.get("fm:notificationActionPerformed");
		expect(tap).toBeDefined();
		tap?.({ notification: { data: { path: "//evil.example" } } });
		tap?.({ notification: { data: { path: "https://evil.example/dm/1" } } });
		tap?.({ notification: {} });
		expect(navigateMock).not.toHaveBeenCalled();
		tap?.({ notification: { data: { kind: "dm", path: "/dm/abc" } } });
		expect(navigateMock).toHaveBeenCalledWith("/dm/abc");
	});
});
