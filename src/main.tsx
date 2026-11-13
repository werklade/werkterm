import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installZoomGuard } from "./lib/zoomGuard";
import { resolveLanguage, setLanguage } from "./i18n";
import { loadSettings } from "./lib/settings";

// Language from the settings cache before the first render, so the UI never flashes in the wrong language.
setLanguage(resolveLanguage(loadSettings().language));

// The webview must not scale the whole UI on ctrl+wheel or pinch; terminal and editor zoom their own font.
installZoomGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
