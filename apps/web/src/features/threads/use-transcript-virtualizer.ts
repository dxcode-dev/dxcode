import { useVirtualizer } from "@tanstack/react-virtual";

/**
 * TanStack Virtual's instance keeps its identity while its items and size
 * change, so the React Compiler skips any function that calls
 * `useVirtualizer`. This adapter is that one uncompiled function: it reads the
 * render values on every render and returns them as plain values, so the
 * compiled transcript caches its rows on them rather than on the instance.
 * Use the instance only in handlers and callbacks, never during render.
 */
export function useTranscriptVirtualizer(
  options: Parameters<typeof useVirtualizer<HTMLDivElement, Element>>[0],
) {
  const virtualizer = useVirtualizer(options);
  return {
    virtualizer,
    virtualItems: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
  };
}
