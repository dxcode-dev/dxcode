import { type ComponentProps, useId, useLayoutEffect, useRef } from "react";
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
  /** A dot at the upper right: the agent finished a turn not yet seen. */
  readonly unread?: boolean;
}

/**
 * The unread dot sits over the Orb's upper right, past the viewBox's
 * corner. The artwork is cut away around it, so the gap shows whatever
 * is behind the Orb: a hovered or selected row as much as a plain one.
 */
const UNREAD_DOT = { cx: 21.1, cy: 4.8, r: 4.6, gap: 1.7 } as const;

export const OrbIcon = ({
  activityStatus = "idle",
  reducedMotion = false,
  unread = false,
  "aria-hidden": ariaHidden = true,
  "aria-label": ariaLabel,
  ...props
}: OrbIconProps) => {
  const unreadMask = useId();
  const renderer = useRef<ReturnType<typeof mountOrbMotion>>(undefined);
  const attach = (node: SVGGElement | null) => {
    if (!node) return;
    const motion = mountOrbMotion(node);
    renderer.current = motion;
    return () => {
      motion?.dispose();
      renderer.current = undefined;
    };
  };
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
      data-unread={unread ? "" : undefined}
      overflow={unread ? "visible" : undefined}
      {...props}
    >
      {unread ? (
        <mask id={unreadMask} maskUnits="userSpaceOnUse">
          <rect x="-2" y="-2" width="28" height="28" fill="#fff" />
          <circle
            cx={UNREAD_DOT.cx}
            cy={UNREAD_DOT.cy}
            r={UNREAD_DOT.r + UNREAD_DOT.gap}
            fill="#000"
          />
        </mask>
      ) : null}
      {/* The artwork keeps its node when the dot comes and goes, so a
          working Orb does not restart its spin. */}
      <g mask={unread ? `url(#${unreadMask})` : undefined}>
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
      </g>
      {unread ? (
        <circle
          className="orb-unread-dot"
          cx={UNREAD_DOT.cx}
          cy={UNREAD_DOT.cy}
          r={UNREAD_DOT.r}
          fill="var(--unread)"
          stroke="none"
        />
      ) : null}
    </svg>
  );
};
