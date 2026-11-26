import type { ModeId } from "@dx/domain";

export const REASONING_MODES = [
  {
    id: "ultra",
    label: "Ultra",
    description: "The most capable mode for hard, open-ended tasks.",
  },
  {
    id: "high",
    label: "High",
    description: "Deep reasoning for hard tasks.",
  },
  {
    id: "medium",
    label: "Medium",
    description: "Balanced intelligence, speed, and cost for most tasks.",
  },
  {
    id: "low",
    label: "Low",
    description: "Fast, low-cost mode for small, well-defined tasks.",
  },
] as const satisfies ReadonlyArray<{
  readonly id: ModeId;
  readonly label: string;
  readonly description: string;
}>;

export const reasoningModeId = (mode: ModeId): ModeId =>
  REASONING_MODES.find(({ id }) => id === mode)?.id ?? "medium";
