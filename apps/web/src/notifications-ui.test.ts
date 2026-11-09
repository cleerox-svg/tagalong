import { NOTIFICATION_KINDS } from "@tagalong/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The FirebaseMessaging plugin, as registered through @capacitor/core.
const fm = {
	checkPermissions: vi.fn(async () => ({ receive: "prompt" as string })),
	requestPermissions: vi.fn(async () => ({ receive: "granted" as string })),
	getToken: vi.fn(async () => ({ token: "fcm-1" })),
	addListener: vi.fn(async () => ({ remove: async () => undefined })),
};
vi.mock("@capacitor/core", () => ({ registerPlugin: () => fm }));
vi.mock("capacitor-secure-storage-plugin", () => ({
	SecureStoragePlugin: {
		get: async () => {
			throw new Error("Item with given key does not exist");
		},
		set: async () => ({ value: true }),
		remove: async () => ({ value: true }),
	},
}));
vi.mock("./router.js", () => ({ navigate: vi.fn(), linkTo: () => () => undefined }));

const native = await import("./native.js");
const { pushOfferResult } = await import("./PushOffer.js");
const { visibleKinds } = await import("./Notifications.js");

const ASKED = "budgetrip.push-asked";
let storage: Map<string, string>;

function setNative(on: boolean) {
	const g = globalThis as { Capacitor?: unknown };
	if (!on) delete g.Capacitor;
	else g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
}

beforeEach(() => {
	storage = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	});
	fm.checkPermissions.mockReset().mockResolvedValue({ receive: "prompt" });
	fm.requestPermissions.mockReset().mockResolvedValue({ receive: "granted" });
	fm.getToken.mockReset().mockResolvedValue({ token: "fcm-1" });
	native.resetNativeStateForTests();
});
afterEach(() => {
	setNative(false);
	vi.unstubAllGlobals();
});

describe("in-context push offer", () => {
	it("is never offered in the browser, and declining there remembers nothing", async () => {
		expect(await native.shouldOfferPush()).toBe(false);
		native.declinePushInContext();
		expect(storage.has(ASKED)).toBe(false);
		expect(await native.askForPushInContext()).toBe("unsupported");
		expect(fm.requestPermissions).not.toHaveBeenCalled();
	});

	it("is offered in the app only while the OS hasn't been asked", async () => {
		setNative(true);
		expect(await native.shouldOfferPush()).toBe(true);
		fm.checkPermissions.mockResolvedValue({ receive: "granted" });
		expect(await native.shouldOfferPush()).toBe(false);
		fm.checkPermissions.mockResolvedValue({ receive: "denied" });
		expect(await native.shouldOfferPush()).toBe(false);
	});

	it("checking whether to offer never shows the system dialog or remembers anything", async () => {
		setNative(true);
		await native.shouldOfferPush();
		expect(fm.requestPermissions).not.toHaveBeenCalled();
		expect(storage.has(ASKED)).toBe(false);
	});

	it("'Not now' remembers, so it isn't offered again", async () => {
		setNative(true);
		native.declinePushInContext();
		expect(storage.get(ASKED)).toBe("1");
		expect(await native.shouldOfferPush()).toBe(false);
		expect(fm.requestPermissions).not.toHaveBeenCalled();
	});

	it("'Turn on' shows the system dialog, then remembers", async () => {
		setNative(true);
		expect(await native.askForPushInContext()).toBe("granted");
		expect(fm.requestPermissions).toHaveBeenCalledTimes(1);
		expect(storage.get(ASKED)).toBe("1");
	});

	it("'Turn on' remembers a refusal too", async () => {
		setNative(true);
		fm.requestPermissions.mockResolvedValue({ receive: "denied" });
		expect(await native.askForPushInContext()).toBe("denied");
		expect(storage.get(ASKED)).toBe("1");
	});

	it("a failure before the system dialog leaves it to be offered again", async () => {
		setNative(true);
		fm.requestPermissions.mockRejectedValue(new Error("boom"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(await native.askForPushInContext()).toBe("failed");
		expect(storage.has(ASKED)).toBe(false);
		expect(await native.shouldOfferPush()).toBe(true);
	});

	it("says what happened after each answer", () => {
		expect(pushOfferResult("granted")).toBe("Notifications are on for this phone.");
		expect(pushOfferResult("denied")).toMatch(/Settings/);
		expect(pushOfferResult("failed")).toMatch(/couldn't/);
		expect(pushOfferResult("not_now")).toMatch(/any time/);
	});
});

describe("notification kinds shown", () => {
	it("shows every kind with Tagalong on", () => {
		expect(visibleKinds(true)).toEqual([...NOTIFICATION_KINDS]);
	});

	it("shows only price drops without Tagalong", () => {
		expect(visibleKinds(false)).toEqual(["price_drop"]);
	});
});
