import { startShellPrefetch } from "./features/navigation/shell-queries.js";
import { peekBootSessionRead } from "./shared/auth/boot-session.js";

// The first-load reads start as soon as the boot session check finds someone
// signed in (#1379, #1599), while the app's code below still evaluates.
// main.tsx starts them on the same condition later, which does nothing then.
void peekBootSessionRead().then((session) => {
  if (session !== null && session !== undefined) startShellPrefetch();
});

// The app evaluates in two tasks instead of one. The API client comes first:
// its graph builds the Effect schemas for every API response, about half of
// the boot's script time on a phone. Then the browser gets a turn before
// React and the rest of the app evaluate.
await import("./shared/api/client.js");
await new Promise<void>((resolve) => {
  setTimeout(resolve, 0);
});
const [{ StrictMode }, { createRoot }, { Application }] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import("./main.js"),
]);

const container = document.getElementById("root");
if (container === null) throw new Error("The application root is missing.");

createRoot(container).render(
  <StrictMode>
    <Application />
  </StrictMode>,
);
