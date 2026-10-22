import type { ModeId, ThinkingLevel } from "@dx/domain";
import { MODE_LABELS, MODES } from "./mode-dial-values.js";

export interface ModeSlot {
  readonly model: string;
  readonly thinking: ThinkingLevel;
}
export const AUTO = "auto";
/** An unsaved change to one mode: back to Auto, or a pinned main agent. */
export type ModeDraft = typeof AUTO | ModeSlot;
export type Drafts = Partial<Record<ModeId, ModeDraft>>;
export interface SavedMode {
  readonly config: { readonly agent: ModeSlot };
  readonly source: "default" | "override" | "workspace";
}
export type SavedModes = Readonly<Record<ModeId, SavedMode>>;

const sameSlot = (a: ModeSlot, b: ModeSlot) =>
  a.model === b.model && a.thinking === b.thinking;
/** Choosing a model or effort on an Auto mode pins it, even to the same values. */
const draftChanges = (draft: ModeDraft | undefined, saved: SavedMode) =>
  draft !== undefined &&
  (draft === AUTO
    ? saved.source === "override"
    : saved.source !== "override" || !sameSlot(draft, saved.config.agent));
export const changedModes = (drafts: Drafts, saved: SavedModes | undefined) =>
  saved === undefined
    ? []
    : MODES.filter((mode) => draftChanges(drafts[mode], saved[mode]));
export const listModes = (modes: ReadonlyArray<ModeId>) => {
  const labels = modes.map((mode) => MODE_LABELS[mode]);
  return labels.length < 2
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
};
