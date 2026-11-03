import {
  type ComponentProps,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { mountOrbRenderer } from "./orb-canvas.js";
import {
  ORB_IDLE_ARTWORK,
  ORB_IDLE_TRANSFORM,
  ORB_PATH_STROKE_WIDTH,
  ORB_PATH_TRANSFORM,
  ORB_UNREAD_DOT,
} from "./orb-motion.js";

export interface OrbIconProps extends ComponentProps<"svg"> {
  readonly activityStatus?: "idle" | "working";
  readonly reducedMotion?: boolean;
  /** A dot at the upper right: the agent finished a turn not yet seen. */
  readonly unread?: boolean;
  /**
   * Draw an idle Orb as one element, its artwork a mask image, until it
   * first works; from then it keeps the animated artwork. For long lists,
   * such as the sidebar, where each Orb's 20 SVG nodes are most of a row's
   * style, layout, and paint work (#1468).
   */
  readonly staticWhenIdle?: boolean;
}

/** The idle artwork as an SVG image, stroked black for use as a mask. */
const idleMaskSvg = () => {
  let paths = "";
  for (const { d, opacity } of ORB_IDLE_ARTWORK)
    if (d !== "")
      paths += `<path d='${d}' opacity='${opacity}' transform='${ORB_PATH_TRANSFORM}' stroke-width='${ORB_PATH_STROKE_WIDTH}'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='#000' stroke-linecap='round' stroke-linejoin='round'><g transform='${ORB_IDLE_TRANSFORM}'>${paths}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const staticRule = (mask: string) =>
  `.orb-icon-static{background-color:currentColor;mask:url("${mask}") center/100% 100% no-repeat}`;

/**
 * Adds the one rule every static Orb shares to the document, once, as a
 * constructed sheet, so no Orb carries the image inline. The rule starts
 * with the SVG and switches to a bitmap of it at the rows' device size:
 * an SVG mask replays its 16 paths for every Orb it paints, while a bitmap
 * paints as one image.
 */
const installedIn = new WeakSet<Document>();
const installStaticOrb = (node: SVGSVGElement | null) => {
  const document = node?.ownerDocument;
  const view = document?.defaultView;
  if (
    node === null ||
    document === undefined ||
    view == null ||
    installedIn.has(document)
  )
    return;
  installedIn.add(document);
  const svg = idleMaskSvg();
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(staticRule(svg));
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  // Sidebar rows draw it at 14px. Measuring the Orb instead would force
  // layout inside the closed phone drawer, which skips rendering.
  const size = Math.ceil(14 * view.devicePixelRatio);
  const image = new view.Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.drawImage(image, 0, 0, size, size);
    sheet.replaceSync(staticRule(canvas.toDataURL("image/png")));
  };
  image.src = svg;
};

export const OrbIcon = ({
  activityStatus = "idle",
  reducedMotion = false,
  unread = false,
  staticWhenIdle = false,
  "aria-hidden": ariaHidden = true,
  "aria-label": ariaLabel,
  className,
  ...props
}: OrbIconProps) => {
  const unreadMask = useId();
  const renderer = useRef<ReturnType<typeof mountOrbRenderer>>(undefined);
  const attach = (node: SVGGElement | null) => {
    if (!node) return;
    const motion = mountOrbRenderer(node);
    renderer.current = motion;
    return () => {
      motion?.dispose();
      renderer.current = undefined;
    };
  };
  // Synchronize the persistent imperative SVG renderer before paint. Keeping
  // its DOM node across status changes preserves angular position and velocity.
  useLayoutEffect(() => {
    renderer.current?.update({ activityStatus, reducedMotion, unread });
  }, [activityStatus, reducedMotion, unread]);
  const hidden = ariaHidden !== false && ariaHidden !== "false";
  // Once it works, the Orb keeps its animated artwork, so it settles back
  // to rest instead of snapping to the static image.
  const [animated, setAnimated] = useState(!staticWhenIdle);
  if (!animated && (activityStatus === "working" || unread)) setAnimated(true);
  if (!animated)
    return (
      <svg
        ref={installStaticOrb}
        viewBox="0 0 24 24"
        aria-hidden={ariaHidden}
        role={hidden ? undefined : "img"}
        aria-label={hidden ? undefined : (ariaLabel ?? "Idle")}
        data-activity-status="idle"
        className={
          className === undefined
            ? "orb-icon-static"
            : `${className} orb-icon-static`
        }
        {...props}
      />
    );
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
      className={className}
      {...props}
    >
      {unread ? (
        <mask id={unreadMask} maskUnits="userSpaceOnUse">
          <rect x="-2" y="-2" width="28" height="28" fill="#fff" />
          <circle
            cx={ORB_UNREAD_DOT.cx}
            cy={ORB_UNREAD_DOT.cy}
            r={ORB_UNREAD_DOT.r + ORB_UNREAD_DOT.gap}
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
          cx={ORB_UNREAD_DOT.cx}
          cy={ORB_UNREAD_DOT.cy}
          r={ORB_UNREAD_DOT.r}
          fill="var(--unread)"
          stroke="none"
        />
      ) : null}
    </svg>
  );
};
