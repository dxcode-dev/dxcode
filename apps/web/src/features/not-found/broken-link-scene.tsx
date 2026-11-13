import type * as React from "react";
import "./broken-link-scene.css";

import {
  type ChainLink as ChainLinkData,
  LEFT_BREAK,
  LEFT_LINKS,
  poseStyle,
  RIGHT_BREAK,
  RIGHT_LINKS,
} from "./broken-link-poses.js";

/**
 * A chain strung between two posts strains and snaps; each half swings down
 * and hangs from its post, and the repair tag, carrying 404 and the path the
 * visitor followed, drops to the ground. The docs' 404 page shows this
 * scene's markup (apps/docs/src/lib/broken-link-scene.ts, rendered from this
 * component): change both together. Poses: broken-link-poses.ts.
 */

/** The tag fits about this many characters of the path. */
const TAG_CHARACTERS = 24;

const styled = ({ face, poses }: ChainLinkData) => ({
  // Where the link sits on the whole chain: unique within a half.
  key: poses[0][0],
  face,
  style: poseStyle(poses) as React.CSSProperties,
});
const LEFT = LEFT_LINKS.map(styled);
const RIGHT = RIGHT_LINKS.map(styled);
const LEFT_END = poseStyle(LEFT_BREAK) as React.CSSProperties;
const RIGHT_END = poseStyle(RIGHT_BREAK) as React.CSSProperties;

/** The broken middle link's two halves, each with a jagged end. */
const BROKEN_LEFT = "M0 -8.5H-6.5A8.5 8.5 0 0 0 -6.5 8.5H-1.5L0.5 6.5";
const BROKEN_RIGHT = "M0 8.5H6.5A8.5 8.5 0 0 0 6.5 -8.5H1.5L-0.4 -6.6";

/**
 * Metal flecks: where each lands, the shard's outline, and the offset it
 * flies from (the break) as it falls.
 */
const FLECKS = [
  { x: 236, d: "M0 -4L5 1L-2 4Z" },
  { x: 262, d: "M-3.5 -2.5L4 -1L0 3.5Z" },
  { x: 386, d: "M-4 0L2.5 -3.5L3.5 3Z" },
  { x: 412, d: "M0 -3.5L3.6 2.6L-3.6 2.6Z" },
].map(({ x, d }, index) => ({
  x,
  d,
  className: `nf-fleck nf-fleck-${index + 1}`,
  style: {
    "--nf-from-x": `${320 - x}px`,
    "--nf-from-y": "-148px",
  } as React.CSSProperties,
}));

const tagLabel = (path: string) =>
  path.length > TAG_CHARACTERS ? `${path.slice(0, TAG_CHARACTERS - 1)}…` : path;

function ChainLink({
  face,
  style,
}: {
  readonly face: boolean;
  readonly style: React.CSSProperties;
}) {
  return (
    <g className="nf-pose" style={style}>
      {face ? (
        <>
          <rect
            className="nf-link-shade"
            x="-15"
            y="-8.5"
            width="30"
            height="17"
            rx="8.5"
          />
          <rect
            className="nf-link"
            x="-15"
            y="-8.5"
            width="30"
            height="17"
            rx="8.5"
          />
        </>
      ) : (
        <>
          <path className="nf-link-shade" d="M-13 0H13" />
          <path className="nf-link" d="M-13 0H13" />
          <path className="nf-link-glint" d="M-9 -1.2H4" />
        </>
      )}
    </g>
  );
}

function BrokenHalf({
  d,
  style,
}: {
  readonly d: string;
  readonly style: React.CSSProperties;
}) {
  return (
    <g className="nf-pose nf-broken" style={style}>
      <path className="nf-link-shade" d={d} />
      <path className="nf-link" d={d} />
    </g>
  );
}

/** A bollard; `side` is 1 when the chain leaves it to the right. */
function Post({ cx, side }: { readonly cx: number; readonly side: 1 | -1 }) {
  return (
    <g className="nf-post">
      <ellipse className="nf-shadow" cx={cx} cy="345" rx="34" ry="5" />
      <path
        className="nf-post-body"
        d={`M${cx - 21} 344V130a21 21 0 0 1 42 0V344Z`}
      />
      <path
        className="nf-post-light"
        d={`M${cx - 13} 340V132a13 13 0 0 1 9 -12.4V340Z`}
      />
      <rect
        className="nf-post-band"
        x={cx - 21}
        y="166"
        width="42"
        height="13"
      />
      <rect
        className="nf-post-band"
        x={cx - 21}
        y="186"
        width="42"
        height="5"
      />
      <circle className="nf-eye-shade" cx={cx + 18 * side} cy="140" r="6.5" />
      <circle className="nf-eye" cx={cx + 18 * side} cy="140" r="6.5" />
    </g>
  );
}

function Flecks() {
  return FLECKS.map(({ x, d, className, style }) => (
    <g key={x} className={className} style={style}>
      <path transform={`translate(${x} 342)`} d={d} />
    </g>
  ));
}

/** Each half of the chain drops about the post it hangs from. */
const LEFT_ANCHOR = { transformOrigin: "128px 140px" };
const RIGHT_ANCHOR = { transformOrigin: "512px 140px" };

/**
 * The repair tag, drawn about its hole. It hangs from the broken end by its
 * string, then drops to the ground when the chain snaps.
 */
function Tag({ path }: { readonly path: string }) {
  return (
    <g className="nf-tag-fall">
      <path className="nf-string nf-string-hung" d="M0 -26c-3 7 3 12 0 18" />
      <path
        className="nf-string nf-string-fallen"
        d="M0 -6c14 -12 36 -6 50 64"
      />
      <path className="nf-tag" d="M-46 8l32 -14h28l32 14v54h-92Z" />
      <circle className="nf-tag-hole-ring" cx="0" cy="0" r="5.5" />
      <circle className="nf-tag-hole" cx="0" cy="0" r="2.6" />
      <text className="nf-tag-code" x="0" y="37" textAnchor="middle">
        404
      </text>
      <path className="nf-tag-rule" d="M-36 46H36" />
      <text className="nf-tag-path" x="0" y="57" textAnchor="middle">
        {tagLabel(path)}
      </text>
    </g>
  );
}

export function BrokenLinkScene({ path }: { readonly path: string }) {
  return (
    <svg
      className="nf-scene"
      viewBox="0 0 640 360"
      role="img"
      aria-label="A chain strung between two posts has snapped. Each half hangs from its post, and a repair tag reading 404 lies on the ground between them."
    >
      <path className="nf-ground" d="M24 344H616" />
      <ellipse
        className="nf-shadow nf-tag-shadow"
        cx="318"
        cy="346"
        rx="48"
        ry="3"
      />
      <Post cx={110} side={1} />
      <Post cx={530} side={-1} />
      <Flecks />
      <g className="nf-half nf-half-left" style={LEFT_ANCHOR}>
        {LEFT.map(({ key, face, style }) => (
          <ChainLink key={key} face={face} style={style} />
        ))}
        <BrokenHalf d={BROKEN_LEFT} style={LEFT_END} />
      </g>
      <g className="nf-half nf-half-right" style={RIGHT_ANCHOR}>
        {RIGHT.map(({ key, face, style }) => (
          <ChainLink key={key} face={face} style={style} />
        ))}
        <BrokenHalf d={BROKEN_RIGHT} style={RIGHT_END} />
      </g>
      <Tag path={path} />
      <g className="nf-snap" strokeLinecap="round">
        <path d="M320 180v-12" />
        <path d="M307 185l-8 -8" />
        <path d="M333 185l8 -8" />
      </g>
    </svg>
  );
}
