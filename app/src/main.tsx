import { hosted } from "./webos-mode";
import { startAccount } from "./webos-account";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./boundary";
import { ReadOnlyBanner } from "./readonlybanner";
// the brand's type, bundled (the app's security policy allows no web fonts)
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles/main.scss";

const root = createRoot(document.getElementById("root")!);
const render = () => root.render(
  <StrictMode>
    <ErrorBoundary
      fallback={() => (
        <div style={{ padding: 32, font: "15px system-ui, sans-serif" }}>
          <b>SketchCraft hit a problem drawing the window.</b>
          <p>{hosted ? "Reopen the app. WebOS offers recovery when a local draft is available." : "Your model is saved. Close and reopen the app (or reload the page)."}</p>
        </div>
      )}
    >
      <App />
      <ReadOnlyBanner />
    </ErrorBoundary>
  </StrictMode>
);

if (hosted) {
  startAccount().then(render).catch(error => root.render(<p role="alert">{String(error)}</p>));
} else render();
