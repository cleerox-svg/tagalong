import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { stripAppCallbackParams } from "./AppCallback.js";
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
