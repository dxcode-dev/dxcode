/**
 * A Thread's row in `execution_workspace`, which pins its provider and its
 * provider sandbox identity (the Cloudflare object, the Freestyle VM). A new
 * Thread's row names its pinned provider (or `e2b` before pins) and is
 * `uninitialized` until its first activation claims it for the provider
 * (`provisioning`), records the sandbox (`initialized`), and, when the
 * provider loses the sandbox, marks it `lost`. The provider may change only
 * in the claim, and the sandbox ID never changes (migration triggers).
 *
 * E2B keeps its own resolver (`e2b/resolver.ts`), which also handles legacy
 * rows; every other provider uses this.
 */
export interface ExecutionWorkspaceRecord {
  readonly provider: string;
  readonly state: string;
  readonly providerSandboxId: string | null;
  readonly initializationAttemptId: string | null;
}

export interface ExecutionWorkspaceRecords {
  /** Null when the Thread has no row (it was deleted). */
  readonly read: (threadId: string) => Promise<ExecutionWorkspaceRecord | null>;
  /** Claims an `uninitialized` row for this provider; false when raced. */
  readonly claim: (threadId: string) => Promise<boolean>;
  /** Records the sandbox of the claim `record` holds; false when raced. */
  readonly initialize: (
    threadId: string,
    record: ExecutionWorkspaceRecord,
    sandboxId: string,
  ) => Promise<boolean>;
  /** The provider no longer has the sandbox. */
  readonly markLost: (threadId: string) => Promise<void>;
}

export const executionWorkspaceRecords = (
  db: D1Database,
  providerId: string,
): ExecutionWorkspaceRecords => ({
  async read(threadId) {
    const row = await db
      .prepare(
        `SELECT provider, state, provider_sandbox_id, initialization_attempt_id
           FROM execution_workspace
          WHERE thread_id = ?
          LIMIT 1`,
      )
      .bind(threadId)
      .first<{
        provider: string;
        state: string;
        provider_sandbox_id: string | null;
        initialization_attempt_id: string | null;
      }>();
    if (row === null) return null;
    return {
      provider: row.provider,
      state: row.state,
      providerSandboxId: row.provider_sandbox_id,
      initializationAttemptId: row.initialization_attempt_id,
    };
  },
  async claim(threadId) {
    const result = await db
      .prepare(
        `UPDATE execution_workspace
            SET provider = ?,
                state = 'provisioning',
                initialization_attempt_id = ?,
                updated_at = ?
          WHERE thread_id = ? AND state = 'uninitialized'`,
      )
      .bind(providerId, crypto.randomUUID(), new Date().toISOString(), threadId)
      .run();
    return result.meta.changes === 1;
  },
  async initialize(threadId, record, sandboxId) {
    const result = await db
      .prepare(
        `UPDATE execution_workspace
            SET state = 'initialized',
                provider_sandbox_id = ?,
                initialization_attempt_id = NULL,
                updated_at = ?
          WHERE thread_id = ?
            AND provider = ?
            AND state = 'provisioning'
            AND initialization_attempt_id IS ?`,
      )
      .bind(
        sandboxId,
        new Date().toISOString(),
        threadId,
        providerId,
        record.initializationAttemptId,
      )
      .run();
    return result.meta.changes === 1;
  },
  async markLost(threadId) {
    await db
      .prepare(
        `UPDATE execution_workspace
            SET state = 'lost', updated_at = ?
          WHERE thread_id = ?
            AND provider = ?
            AND state = 'initialized'`,
      )
      .bind(new Date().toISOString(), threadId, providerId)
      .run();
  },
});
