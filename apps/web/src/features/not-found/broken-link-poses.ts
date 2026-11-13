/**
 * Where each chain link sits as the snapped chain falls. The scene's
 * coordinates are in a 640 × 360 view box: the ground at y = 344, the chain
 * hung from eyes at (128, 140) and (512, 140), and the break at (320, 196).
 *
 * Every link has four poses, and the scene animates through them in order:
 * strung whole between the posts, swung 30° and 60° down about its post
 * (so the fall follows an arc), and hanging straight down from the post,
 * the broken end just above the ground.
 */

/** A link's centre and its angle, in degrees. */
export type Pose = readonly [x: number, y: number, angle: number];

/** A link: whether it faces us, and its four poses. */
export interface ChainLink {
  readonly face: boolean;
  readonly poses: readonly [Pose, Pose, Pose, Pose];
}

const ANCHOR = { x: 128, y: 140 } as const;
const MIRROR_X = 640;
/** Where the hanging chain's links line up, just off the post's face. */
const HANG_X = 134;
const HANG_TOP = 153;
const LINK_STEP = 19.5;
const SWING_DEGREES = [30, 60] as const;

/** The left half strung whole, from the post out to the break. */
const STRUNG: ReadonlyArray<
  readonly [x: number, y: number, angle: number, face: boolean]
> = [
  [150.5, 152.4, 27.2, false],
  [168.3, 161, 24.8, true],
  [186.3, 168.8, 22.1, false],
  [204.5, 175.7, 19.3, true],
  [223.3, 181.8, 16.4, false],
  [242.3, 186.8, 13.3, true],
  [261.5, 190.8, 10.1, false],
  [281, 193.7, 6.8, true],
  [300.5, 195.4, 3.4, false],
];

/** The broken link's left half, at the break. */
const BREAK: Pose = [320, 196, 0];

const round = (value: number) => Math.round(value * 10) / 10;

/** `pose` turned `degrees` clockwise about the left post's eye. */
const swung = ([x, y, angle]: Pose, degrees: number): Pose => {
  const radians = (degrees * Math.PI) / 180;
  const dx = x - ANCHOR.x;
  const dy = y - ANCHOR.y;
  return [
    round(ANCHOR.x + dx * Math.cos(radians) - dy * Math.sin(radians)),
    round(ANCHOR.y + dx * Math.sin(radians) + dy * Math.cos(radians)),
    round(angle + degrees),
  ];
};

/** The `index`th link from the post, hanging straight down. */
const hanging = (index: number): Pose => [
  HANG_X,
  HANG_TOP + LINK_STEP * index,
  90,
];

const posesOf = (strung: Pose, index: number) =>
  [
    strung,
    swung(strung, SWING_DEGREES[0]),
    swung(strung, SWING_DEGREES[1]),
    hanging(index),
  ] as const;

const mirrored = ([x, y, angle]: Pose): Pose => [MIRROR_X - x, y, -angle];

/** The left half's links, from the post outward. */
export const LEFT_LINKS: ReadonlyArray<ChainLink> = STRUNG.map(
  ([x, y, angle, face], index) => ({
    face,
    poses: posesOf([x, y, angle], index),
  }),
);

/** The left half's broken end, the last link from the post. */
export const LEFT_BREAK: ChainLink["poses"] = posesOf(BREAK, STRUNG.length);

/** The right half: the left half mirrored about the scene's centre. */
export const RIGHT_LINKS: ReadonlyArray<ChainLink> = LEFT_LINKS.map(
  ({ face, poses }) => ({
    face,
    poses: poses.map(mirrored) as unknown as ChainLink["poses"],
  }),
);

export const RIGHT_BREAK = LEFT_BREAK.map(
  mirrored,
) as unknown as ChainLink["poses"];

/** A link's poses as the custom properties the scene's CSS animates. */
export const poseStyle = (poses: ChainLink["poses"]) =>
  Object.fromEntries(
    poses.flatMap(([x, y, angle], step) => [
      [`--x${step}`, x],
      [`--y${step}`, y],
      [`--a${step}`, angle],
    ]),
  );
