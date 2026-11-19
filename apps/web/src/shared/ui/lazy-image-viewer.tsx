import * as React from "react";
import { lazyComponent } from "../stale-chunk.js";
import type { ImageViewer } from "./image-viewer.js";

const LoadedImageViewer = lazyComponent(() =>
  import("./image-viewer.js").then((module) => ({
    default: module.ImageViewer,
  })),
);

/**
 * `ImageViewer`, loaded the first time one opens, so the viewer stays out of
 * the Thread page's first load.
 */
export function LazyImageViewer(
  props: React.ComponentProps<typeof ImageViewer>,
) {
  return (
    <React.Suspense fallback={null}>
      <LoadedImageViewer {...props} />
    </React.Suspense>
  );
}
