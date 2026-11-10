import type { CapacitorConfig } from "@capacitor/cli";

// Native shells for iOS and Android (spec §9 phase 6). They load the same Vite
// build as the PWA from `dist/`; nothing here is secret. Firebase config files
// (google-services.json, GoogleService-Info.plist) are added locally and are
// gitignored - never committed.
const config: CapacitorConfig = {
	appId: "com.averrow.budgetrip",
	appName: "Budgetrip",
	webDir: "dist",
	// WebView background before the first paint: the theme --bg, so the native
	// splash hands over to the app without a white flash.
	backgroundColor: "#0b0f1a",
	server: {
		// Serve the Android WebView from https://localhost so it is a secure
		// context, matching iOS (capacitor://localhost) and the PWA.
		androidScheme: "https",
	},
	experimental: {
		ios: {
			spm: {
				// Avoids a SwiftPM package identity collision with the Firebase SDK
				// (capawesome-team/capacitor-firebase#959). Needs CLI 8.4+.
				packageOptions: { "@capacitor-firebase/messaging": { symlink: true } },
			},
		},
	},
	plugins: {
		FirebaseMessaging: {
			// Show notifications while the app is in the foreground too.
			presentationOptions: ["alert", "badge", "sound"],
		},
	},
};

export default config;
