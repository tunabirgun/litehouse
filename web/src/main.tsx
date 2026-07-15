import "@fontsource-variable/eb-garamond";
import "@fontsource-variable/source-sans-3";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { installNativeBridge } from "./native";
import "./styles.css";
import "./workspace.css";
import "./declutter.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Litehouse root element is missing.");
}

void installNativeBridge();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
