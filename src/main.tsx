import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Load the clean-room global reset before the lazy renderer module resolves so first paint has the viewport contract.
import "./rebuild/rebuild-app.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("The Omnia application root element is missing.");
}

void (async () => {
  const { default: Component } = await import("./rebuild/rebuild-app");
  createRoot(root).render(<StrictMode><Component /></StrictMode>);
})();
