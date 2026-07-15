import "@fontsource-variable/eb-garamond";
import "@fontsource-variable/source-sans-3";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";

import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";
import "./workspace.css";
import "./declutter.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Litehouse root element is missing.");
}

function exposeOfflineShellState(state: "registered" | "failed"): void {
  document.documentElement.dataset.offlineShell = state;
  try {
    window.sessionStorage.setItem("litehouse.offline-shell.v1", state);
  } catch {
    // Some privacy modes disable session storage; the DOM status remains available.
  }
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then(() => {
        exposeOfflineShellState("registered");
      })
      .catch(() => {
        exposeOfflineShellState("failed");
        window.dispatchEvent(new CustomEvent("litehouse:offline-shell-error"));
        console.warn("Litehouse could not register its offline shell. No research content was affected.");
      });
  });
}

const Router = import.meta.env.PROD ? HashRouter : BrowserRouter;

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Router>
        <App />
      </Router>
    </ErrorBoundary>
  </StrictMode>,
);
