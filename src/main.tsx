import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installZoomGuard } from "./lib/zoomGuard";
import { resolveLanguage, setLanguage } from "./i18n";
import { loadSettings } from "./lib/settings";
import { settleWithin, uiScaler } from "./lib/uiScale";

// Language and interface size from the settings cache before the first render, so the UI never flashes in the
// wrong language or jumps in size. Both are per device and only live in that cache.
const cached = loadSettings();
setLanguage(resolveLanguage(cached.language));

// The webview must not scale the whole UI on ctrl+wheel or pinch; the interface size setting is the only whole-UI zoom.
installZoomGuard();

// Render once the cached interface size is set, but wait at most 300 ms. Errors are not handled here: App applies
// the size again on mount, which retries a failed attempt (or joins one still running) and reports the error.
void settleWithin(uiScaler.apply(cached.uiScale), 300).then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
