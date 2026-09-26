import type { TranscriptViewModel } from "./transcript-view-model.js";

export type SubagentStatus = "active" | "completed" | "failed" | "interrupted";

export interface SubagentPresentationUpdate {
  readonly taskId: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly currentStatus: string;
  readonly transcript: TranscriptViewModel;
}

export interface SubagentPresentationModel extends SubagentPresentationUpdate {
  readonly accessibleName: string;
}

/** Folds ordered presentation updates to one latest state per task. */
export const deriveSubagentPresentationModels = (
  updates: ReadonlyArray<SubagentPresentationUpdate>,
): ReadonlyArray<SubagentPresentationModel> => {
  const latestByTask = new Map<string, SubagentPresentationModel>();
  for (const update of updates) {
    latestByTask.set(update.taskId, {
      ...update,
      accessibleName: `${update.title} subagent details`,
    });
  }
  return [...latestByTask.values()];
};
