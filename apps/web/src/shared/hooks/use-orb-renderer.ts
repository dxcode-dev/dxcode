import { useLayoutEffect, useRef } from "react";
import { mountOrbRenderer } from "../ui/orb-canvas.js";

/**
 * Owns the Orb's imperative SVG renderer (`mountOrbRenderer`): the returned
 * ref callback mounts it on the artwork group and disposes it when the group
 * goes, and each state change reaches it before paint. Keeping one renderer
 * across status changes preserves its angular position and velocity.
 */
export const useOrbRenderer = ({
  activityStatus,
  reducedMotion,
  unread,
}: {
  readonly activityStatus: "idle" | "working";
  readonly reducedMotion: boolean;
  readonly unread: boolean;
}) => {
  const renderer = useRef<ReturnType<typeof mountOrbRenderer>>(undefined);
  useLayoutEffect(() => {
    renderer.current?.update({ activityStatus, reducedMotion, unread });
  }, [activityStatus, reducedMotion, unread]);
  return (node: SVGGElement | null) => {
    if (!node) return;
    const motion = mountOrbRenderer(node);
    renderer.current = motion;
    return () => {
      motion?.dispose();
      renderer.current = undefined;
    };
  };
};
