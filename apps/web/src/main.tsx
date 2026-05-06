import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { useLauncherInfo } from "./app/hooks/useLauncherInfo";
import { LauncherApp } from "./components/LauncherApp";
import "./styles.css";

const RootBootstrap = () => {
  const { info, error } = useLauncherInfo();

  if (info === null && error === null) {
    return (
      <div className="launcher-shell">
        <div className="launcher-frame">
          <div className="launcher-empty">Loading…</div>
        </div>
      </div>
    );
  }

  // No launcher endpoint means we're talking to a legacy build that only
  // exposes project mode; render the project app.
  if (info === null) {
    return <App />;
  }

  if (info.mode === "launcher") {
    return (
      <LauncherApp
        info={{
          cwd: info.cwd,
          cwdIsInitialized: info.cwdIsInitialized,
          cwdProjectName: info.cwdProjectName,
        }}
      />
    );
  }

  return <App />;
};

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root container '#root' was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <RootBootstrap />
  </StrictMode>,
);
