import * as React from "react";
import type { RestartOrbControlProps } from "./restart-orb-actions.js";

// The Thread page loads this first and it loads the controls, so the list of
// modules Vite preloads with them lives in this chunk, not the Thread page's.
const RestartOrbControl = React.lazy(() => import("./restart-orb-actions.js"));

export default function RestartOrbLoader(props: RestartOrbControlProps) {
  return <RestartOrbControl {...props} />;
}
