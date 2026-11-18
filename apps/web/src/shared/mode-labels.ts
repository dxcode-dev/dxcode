import type { ModeId } from "@dx/domain";

/** dx's built-in agent modes, in order, and the names every picker shows. */
export const MODES: ReadonlyArray<ModeId> = ["low", "medium", "high", "ultra"];
export const MODE_LABELS: Readonly<Record<ModeId, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};
