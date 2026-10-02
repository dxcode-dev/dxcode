import {
  type ComponentProps,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import {
  mountOrbMotion,
  ORB_IDLE_ARTWORK,
  ORB_IDLE_TRANSFORM,
  ORB_PATH_STROKE_WIDTH,
  ORB_PATH_TRANSFORM,
} from "./orb-motion.js";

export interface OrbIconProps extends ComponentProps<"svg"> {
  readonly activityStatus?: "idle" | "working";
  readonly reducedMotion?: boolean;
}

export const OrbIcon = ({
  activityStatus = "idle",
  reducedMotion = false,
  "aria-hidden": ariaHidden = true,
  "aria-label": ariaLabel,
  ...props
}: OrbIconProps) => {
  const renderer = useRef<ReturnType<typeof mountOrbMotion>>(undefined);
  const attach = useCallback((node: SVGGElement | null) => {
    if (!node) return;
    const motion = mountOrbMotion(node);
    renderer.current = motion;
    return () => {
      motion?.dispose();
      renderer.current = undefined;
    };
  }, []);
  // Synchronize the persistent imperative SVG renderer before paint. Keeping
  // its DOM node across status changes preserves angular position and velocity.
  useLayoutEffect(() => {
    renderer.current?.update({ activityStatus, reducedMotion });
  }, [activityStatus, reducedMotion]);
  const hidden = ariaHidden !== false && ariaHidden !== "false";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden}
      role={hidden ? undefined : "img"}
      aria-label={
        hidden
          ? undefined
          : (ariaLabel ?? (activityStatus === "working" ? "Working" : "Idle"))
      }
      data-activity-status={activityStatus}
      {...props}
    >
      <g
        ref={attach}
        data-activity-artwork=""
        transform={ORB_IDLE_TRANSFORM}
        opacity="1.000000"
      >
        {ORB_IDLE_ARTWORK.map((path) => (
          <path
            key={path.id}
            d={path.d}
            opacity={path.opacity}
            transform={ORB_PATH_TRANSFORM}
            strokeWidth={ORB_PATH_STROKE_WIDTH}
          />
        ))}
      </g>
    </svg>
  );
};
