import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installZoomGuard } from "./lib/zoomGuard";

// The webview must not scale the whole UI on ctrl+wheel or pinch; terminal and editor zoom their own font.
installZoomGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
