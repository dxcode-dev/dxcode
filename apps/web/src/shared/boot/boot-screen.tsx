import * as React from "react";
import { lazyComponent } from "../stale-chunk.js";
import { trackBootScreen } from "./boot-wait.js";

const DxLoading = lazyComponent(() =>
  import("../brand/dx-loading.js").then((module) => ({
    default: module.DxLoading,
  })),
);

/**
 * The one loading screen from launch until the first page is ready: the
 * fallback of the application's root Suspense boundary, which the session
 * check, the account's theme, the signed-out pages, and the router's first
 * load all suspend into. It stays mounted while one wait hands over to the
 * next, so the mark never restarts, and fades in only after a short delay
 * (`.boot-screen` in styles.css), so a fast launch shows the page background
 * and then the page, never a flash of the mark.
 */
export function BootScreen() {
  return (
    <div className="boot-screen" ref={trackBootScreen}>
      <React.Suspense fallback={null}>
        <DxLoading label="Loading dx…" variant="screen" />
      </React.Suspense>
    </div>
  );
}
