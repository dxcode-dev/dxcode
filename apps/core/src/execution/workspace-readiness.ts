import type { ThreadId } from "@dx/domain";
import { Schema } from "effect";

const PreparationStatus = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
);

const ExecutionWorkspaceReadinessRow = Schema.Struct({
  ready_at: Schema.NullOr(Schema.String),
  preparation_status: Schema.NullOr(PreparationStatus),
});

export interface ExecutionWorkspaceReadiness {
  readonly ready: boolean;
  readonly preparationStatus: string | null;
}

export const readExecutionWorkspaceReadiness = async (
  db: D1Database,
  threadId: ThreadId,
): Promise<ExecutionWorkspaceReadiness> => {
  const row = await db
    .prepare(
      `SELECT ready_at, preparation_status
         FROM execution_workspace
        WHERE thread_id = ?`,
    )
    .bind(threadId)
    .first();
  if (row === null) return { ready: false, preparationStatus: null };
  const decoded = Schema.decodeUnknownSync(ExecutionWorkspaceReadinessRow)(row);
  return {
    ready: decoded.ready_at !== null,
    preparationStatus:
      decoded.ready_at === null ? decoded.preparation_status : null,
  };
};

export const setExecutionWorkspacePreparationStatus = async (
  db: D1Database,
  threadId: ThreadId,
  status: string | null,
) => {
  if (status !== null) Schema.decodeUnknownSync(PreparationStatus)(status);
  await db
    .prepare(
      `UPDATE execution_workspace
          SET preparation_status = ?, updated_at = ?
        WHERE thread_id = ? AND ready_at IS NULL`,
    )
    .bind(status, new Date().toISOString(), threadId)
    .run();
};

export const markExecutionWorkspaceReady = async (
  db: D1Database,
  threadId: ThreadId,
) => {
  const readyAt = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE execution_workspace
          SET ready_at = COALESCE(ready_at, ?),
              preparation_status = NULL,
              updated_at = ?
        WHERE thread_id = ?`,
    )
    .bind(readyAt, readyAt, threadId)
    .run();
  if (result.meta.changes !== 1)
    throw new Error("Execution workspace readiness record is missing.");
};
