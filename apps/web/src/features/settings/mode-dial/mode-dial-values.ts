import type { ModeId, ThinkingLevel } from "@dx/domain";
export const MODES: ReadonlyArray<ModeId> = ["low", "medium", "high", "ultra"];
export const MODE_LABELS: Readonly<Record<ModeId, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};
export const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
