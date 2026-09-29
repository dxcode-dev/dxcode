import type * as React from "react";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";

const MAX_FRAMES = 60;

/**
 * Scroll a Pierre-rendered line into view once per mount. Key this by the
 * reveal request so each new request scrolls again without remounting the
 * file view (which would discard an editor's unsaved changes). Pierre renders
 * rows asynchronously inside a shadow root, so wait a bounded number of
 * frames for the row to appear.
 */
export function RevealLine({
  host,
  line,
}: {
  readonly host: React.RefObject<HTMLElement | null>;
  readonly line: number;
}) {
  useMountEffect(() => {
    let frame = 0;
    let handle = 0;
    const attempt = () => {
      const root = host.current?.querySelector("diffs-container")?.shadowRoot;
      const row = root?.querySelector<HTMLElement>(
        `[data-line="${line}"]:not([data-gutter-buffer])`,
      );
      if (row !== null && row !== undefined) {
        row.scrollIntoView({ block: "center" });
        return;
      }
      frame += 1;
      if (frame < MAX_FRAMES) handle = requestAnimationFrame(attempt);
    };
    handle = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(handle);
  });
  return null;
}
