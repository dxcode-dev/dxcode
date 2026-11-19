import type { ThinkingLevel } from "@dx/domain";

const EFFORT_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/** A model effort as the model picker names it, such as "X-High". */
export const effortLabel = (effort: ThinkingLevel) => EFFORT_LABELS[effort];
