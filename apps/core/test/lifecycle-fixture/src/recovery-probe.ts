import { extend } from "@flue/runtime/cloudflare";

/**
 * Durable Object probe for the submission-recovery scenario (#1934).
 *
 * It counts the SQLite rows each alarm wake reads and writes, from the
 * cursors' own `rowsRead`/`rowsWritten` (the counters Durable Object
 * analytics bill), and it can wedge a running turn the way production
 * thr_ca698d5a was wedged: the turn's attempts are used up, the object
 * resets, and from then on every conversation append fails with a storage
 * error that resets the object again.
 */

export interface RecoveryWake {
  /** Which object instance (counted from 1) served the wake. */
  instance: number;
  at: number;
  durationMs: number;
  rowsRead: number;
  rowsWritten: number;
  /** Conversation appends the wake attempted while appends were failing. */
  failedAppends: number;
}

type SqlCursor = {
  rowsRead: number;
  rowsWritten: number;
  toArray(): unknown[];
};
type SqlExec = (query: string, ...bindings: unknown[]) => SqlCursor;
type ProbedState = {
  id: { toString(): string };
  storage: { sql: { exec: SqlExec }; sync(): Promise<void> };
  abort(reason?: string): never;
};

interface Probe {
  instances: number;
  wakes: RecoveryWake[];
  /** Cursors since the last wake ended, for the current instance. */
  cursors: SqlCursor[];
  failedAppends: number;
  /** The unwrapped `exec` of the current instance. */
  exec: SqlExec;
  failing: boolean | undefined;
  /** Wakes this instance served; a first wake keeps its constructor reads. */
  instanceWakes: number;
  resetPending: boolean;
  /** Records the wake in progress; set while a wake runs. */
  finishWake?: () => void;
}

/** Per object, in this isolate; the Worker reads it through the fixture routes. */
const probes = new Map<string, Probe>();

export const recoveryWakes = (objectId: string) => {
  const probe = probes.get(objectId);
  return { instances: probe?.instances ?? 0, wakes: probe?.wakes ?? [] };
};

const FAULT_TABLE = "fixture_append_fault";
const STORAGE_RESET =
  "Internal error in Durable Object storage caused object to be reset; reference = fixture-1934";

const probeOf = (ctx: DurableObjectState) =>
  probes.get((ctx as unknown as ProbedState).id.toString()) as Probe;

export const cloudflare = extend({
  // The generated class extends this one, so its stores already hold this
  // `sql` object; replacing `exec` on it reaches every later query.
  base: (Base) =>
    class RecoveryProbe extends Base {
      constructor(ctx: DurableObjectState, env: unknown) {
        const state = ctx as unknown as ProbedState;
        const objectId = state.id.toString();
        const sql = state.storage.sql;
        const exec = sql.exec.bind(sql);
        const previous = probes.get(objectId);
        const probe: Probe = {
          instances: (previous?.instances ?? 0) + 1,
          wakes: previous?.wakes ?? [],
          cursors: [],
          failedAppends: 0,
          exec,
          failing: undefined,
          instanceWakes: 0,
          resetPending: false,
        };
        probes.set(objectId, probe);
        sql.exec = (query, ...bindings) => {
          if (/INSERT INTO flue_conversation_stream_batches\b/.test(query)) {
            probe.failing ??=
              exec(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='${FAULT_TABLE}'`,
              ).toArray().length > 0;
            if (probe.failing) {
              probe.failedAppends += 1;
              // Production's append threw this inside its transaction, the
              // caller logged it, and the platform then reset the object,
              // discarding the invocation's unsynced writes. The reset lands
              // when the wake ends (or at once outside a wake).
              // The reset lands once the throw has been caught and logged.
              if (!probe.resetPending) {
                probe.resetPending = true;
                setTimeout(() => {
                  probe.finishWake?.();
                  state.abort(STORAGE_RESET);
                }, 0);
              }
              throw new Error(STORAGE_RESET);
            }
          }
          const cursor = exec(query, ...bindings);
          probe.cursors.push(cursor);
          return cursor;
        };
        // Reads before the first wake belong to that wake, as they do in
        // analytics.
        super(ctx, env);
      }

      async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
        const probe = probeOf(this.ctx);
        const startedAt = Date.now();
        // Requests between wakes are not the wake's reads.
        if (probe.instanceWakes > 0) probe.cursors.length = 0;
        probe.instanceWakes += 1;
        probe.finishWake = () => {
          probe.finishWake = undefined;
          let rowsRead = 0;
          let rowsWritten = 0;
          for (const cursor of probe.cursors.splice(0)) {
            rowsRead += cursor.rowsRead;
            rowsWritten += cursor.rowsWritten;
          }
          probe.wakes.push({
            instance: probe.instances,
            at: startedAt,
            durationMs: Date.now() - startedAt,
            rowsRead,
            rowsWritten,
            failedAppends: probe.failedAppends,
          });
          probe.failedAppends = 0;
        };
        try {
          await super.alarm?.(alarmInfo);
        } finally {
          probe.finishWake?.();
        }
      }

      /** Use up the running turn's attempts, fail every later append, and reset. */
      async wedgeRecovery() {
        const probe = probeOf(this.ctx);
        const running = probe
          .exec(
            "SELECT submission_id FROM flue_agent_submissions WHERE status = 'running' LIMIT 1",
          )
          .toArray()[0] as { submission_id: string } | undefined;
        if (running === undefined) return null;
        probe.exec(
          "UPDATE flue_agent_submissions SET attempt_count = max_attempts WHERE submission_id = ?",
          running.submission_id,
        );
        probe.exec(`CREATE TABLE IF NOT EXISTS ${FAULT_TABLE} (id INTEGER)`);
        await (this.ctx as unknown as ProbedState).storage.sync();
        // Reset after this call answers, so the caller gets the submission.
        setTimeout(
          () => (this.ctx as unknown as ProbedState).abort(STORAGE_RESET),
          50,
        );
        return { submissionId: running.submission_id };
      }

      /** Lets appends succeed again. */
      async healAppends() {
        const probe = probeOf(this.ctx);
        probe.exec(`DROP TABLE IF EXISTS ${FAULT_TABLE}`);
        probe.failing = false;
      }

      /** The submission's row, as Flue's coordinator left it. */
      async submissionRow(submissionId: string) {
        return (
          (probeOf(this.ctx)
            .exec(
              "SELECT status, error FROM flue_agent_submissions WHERE submission_id = ?",
              submissionId,
            )
            .toArray()[0] as
            | { status: string; error: string | null }
            | undefined) ?? null
        );
      }

      /** Rows of each Flue table, to size the Thread. */
      async storageShape() {
        const probe = probeOf(this.ctx);
        const count = (table: string) =>
          (
            probe.exec(`SELECT count(*) AS n FROM ${table}`).toArray()[0] as {
              n: number;
            }
          ).n;
        return {
          batches: count("flue_conversation_stream_batches"),
          historyEntries: count("flue_history_entries"),
          checkpointOffset:
            (
              probe
                .exec(
                  "SELECT head_offset FROM flue_conversation_fold_checkpoints",
                )
                .toArray()[0] as { head_offset?: string } | undefined
            )?.head_offset ?? null,
        };
      }
    },
});
