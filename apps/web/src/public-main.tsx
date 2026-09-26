import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Application } from "./main.js";
import "./public-root.css";

const container = document.getElementById("root");
if (container === null) throw new Error("The application root is missing.");

// Mount the shared query/auth providers once. Replacing a temporary landing root
// after idle would discard an email or a Turnstile challenge already in progress.
createRoot(container).render(
  <StrictMode>
    <Application />
  </StrictMode>,
);
