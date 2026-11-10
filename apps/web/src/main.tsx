import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { stripAppCallbackParams } from "./AppCallback.js";
// Self-hosted Sora (OFL-1.1): no third-party font request.
import "@fontsource-variable/sora";
import "./styles.css";

// A sign-in code meant for the app must not linger in the address bar or history.
stripAppCallbackParams();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
