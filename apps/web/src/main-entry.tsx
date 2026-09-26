import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Application } from "./main.js";

const container = document.getElementById("root");
if (container === null) throw new Error("The application root is missing.");

createRoot(container).render(
  <StrictMode>
    <Application />
  </StrictMode>,
);
