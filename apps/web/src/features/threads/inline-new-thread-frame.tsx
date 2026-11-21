import type * as React from "react";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import {
  type FocusNewThread,
  useNewThreadSurface,
} from "../../shared/new-thread-surface.js";
import "./inline-new-thread-frame.css";

/**
 * While mounted, "new Thread" calls `focus`, the inline composer's, instead
 * of opening the dialog. Undefined registers nothing.
 */
export function useInlineNewThread(focus: FocusNewThread | undefined) {
  const { registerInlineNewThread } = useNewThreadSurface();
  useMountEffect(() =>
    focus === undefined ? undefined : registerInlineNewThread?.(focus),
  );
}

/**
 * The New Thread composer on the page's own surface (`InlineNewThread`), with
 * an outline and no shadow, so it reads as part of the page. While
 * the composer loads it keeps the composer's height, so nothing moves when
 * it appears.
 */
export function InlineNewThreadFrame({
  loading = false,
  children,
}: {
  readonly loading?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <section
      className="new-thread-surface inline-new-thread"
      aria-label="New thread"
      aria-busy={loading || undefined}
    >
      {loading ? (
        <span className="sr-only" role="status">
          Loading New Thread draft…
        </span>
      ) : (
        children
      )}
    </section>
  );
}
