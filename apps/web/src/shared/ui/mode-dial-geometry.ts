import type { ModeId } from "@dx/domain";
export const DIAL_LABELS: Readonly<Record<ModeId, string>> = {
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  ultra: "ULTRA",
};

export const DIAL_CENTER = { x: 119, y: 97 } as const;

export const DIAL_MODE_ORDER = [
  "low",
  "medium",
  "high",
  "ultra",
] as const satisfies ReadonlyArray<ModeId>;

export const DIAL_POSITION_BY_MODE: Record<
  ModeId,
  {
    readonly angle: number;
    readonly labelX: number;
    readonly labelY: number;
  }
> = {
  low: { angle: 157, labelX: 46, labelY: 126 },
  medium: { angle: 221, labelX: 59, labelY: 45 },
  high: { angle: 285, labelX: 139, labelY: 21 },
  ultra: { angle: 384, labelX: 187, labelY: 126 },
};

export const pointOnDial = (angle: number, radius: number) => {
  const radians = (angle * Math.PI) / 180;
  return {
    x: DIAL_CENTER.x + Math.cos(radians) * radius,
    y: DIAL_CENTER.y + Math.sin(radians) * radius,
  };
};

export const DIAL_TICKS = Array.from({ length: 23 }, (_, index) => {
  const angle = 157 + index * ((384 - 157) / 22);
  const inner = pointOnDial(angle, 49);
  const outer = pointOnDial(angle, 53);
  return {
    id: `dial-tick-${index}`,
    angle,
    x1: inner.x,
    y1: inner.y,
    x2: outer.x,
    y2: outer.y,
  };
});

export const KNOB_RIDGES = Array.from({ length: 40 }, (_, index) => {
  const angle = index * 9;
  const inner = pointOnDial(angle, 35);
  const outer = pointOnDial(angle, 41);
  return {
    id: `knob-ridge-${index}`,
    x1: inner.x,
    y1: inner.y,
    x2: outer.x,
    y2: outer.y,
  };
});

export const angularDistance = (left: number, right: number) =>
  Math.abs(((left - right + 540) % 360) - 180);
