import { ThreadId, Timestamp, type UserId } from "@dx/domain";
import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import {
  publishRealtimeInvalidation,
  publishUserInvalidation,
  threadPresentUsers,
} from "../realtime/publication.js";
import { markThreadSeen } from "./attention-d1.js";

const ThreadActivityInput = Schema.Struct({
  threadId: ThreadId,
  submissionId: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.Literals(["submitted", "settled"]),
  state: Schema.Literals(["working", "settled"]),
  /** How a settled submission ended. */
  outcome: Schema.optional(Schema.Literals(["completed", "failed", "aborted"])),
  occurredAt: Timestamp,
});

type ThreadActivityInput = typeof ThreadActivityInput.Type;

class ThreadActivityPersistenceError extends Data.TaggedError(
  "ThreadActivityPersistenceError",
)<{ readonly cause: unknown }> {}

export const threadActivityFromFlue = (
  event: FlueObservation,
): ThreadActivityInput | undefined => {
  if (event.instanceId === undefined) return undefined;
  switch (event.type) {
    case "submission_queued":
    case "submission_running":
      return Option.getOrUndefined(
        Schema.decodeOption(ThreadActivityInput)({
          threadId: event.instanceId,
          submissionId: event.submissionId,
          kind: "submitted",
          state: "working",
          occurredAt: event.timestamp,
        }),
      );
    case "submission_settled":
      return Option.getOrUndefined(
        Schema.decodeOption(ThreadActivityInput)({
          threadId: event.instanceId,
          submissionId: event.submissionId,
          kind: "settled",
          state: "settled",
          outcome: event.outcome,
          occurredAt: event.timestamp,
        }),
      );
    default:
      return undefined;
  }
};

const record = (bindings: Bindings, activity: ThreadActivityInput) =>
  Effect.gen(function* () {
    const db = yield* decodeD1Binding(bindings.DB);
    const recordedAt = yield* DateTime.now.pipe(
      Effect.flatMap(Schema.encodeEffect(Schema.DateTimeUtcFromString)),
    );
    const occurredAt = yield* Schema.encodeEffect(Schema.DateTimeUtcFromString)(
      activity.occurredAt,
    );
    const eventKey = `submission:${activity.submissionId}:${activity.kind}`;
    // A finished turn, completed or failed, is what a person comes back
    // for; one they aborted they were watching.
    const finished =
      activity.outcome === "completed" || activity.outcome === "failed";
    // Needs you: a turn starting answers what the Thread asked of its owner
    // before it. A root Thread whose turn failed, with no other turn under
    // way, asks unless it already asks something; only the observation that
    // recorded the settlement does, so a replay cannot list a Thread the
    // owner dismissed. Each returns the owner when it changed the list.
    const returningOwner = `RETURNING (SELECT owner_user_id FROM threads
        WHERE threads.id = thread_attention_request.thread_id) AS owner_user_id`;
    const needsYou =
      activity.state === "working"
        ? db
            .prepare(
              `DELETE FROM thread_attention_request
                WHERE thread_id = ?1 AND requested_at < ?2
               ${returningOwner}`,
            )
            .bind(activity.threadId, occurredAt)
        : activity.outcome === "failed"
          ? db
              .prepare(
                `INSERT INTO thread_attention_request (
                   thread_id, kind, requested_at
                 )
                 SELECT id, 'failed', ?3 FROM threads
                  WHERE id = ?1 AND parent_thread_id IS NULL
                    AND EXISTS (
                      SELECT 1 FROM thread_activity
                       WHERE thread_id = ?1 AND event_key = ?2
                         AND recorded_at = ?4)
                    AND NOT EXISTS (
                      SELECT 1 FROM thread_activity_submission
                       WHERE thread_id = ?1 AND state = 'working')
                 ON CONFLICT (thread_id) DO NOTHING
                 ${returningOwner}`,
              )
              .bind(activity.threadId, eventKey, occurredAt, recordedAt)
          : undefined;
    const [, recorded, projected, listChanged] = yield* Effect.tryPromise({
      try: () =>
        db.batch([
          db
            .prepare(
              `INSERT INTO thread_activity_submission (
                 thread_id, submission_id, state, observed_at
               ) VALUES (?, ?, ?, ?)
               ON CONFLICT(thread_id, submission_id) DO UPDATE SET
                 state = CASE
                   WHEN thread_activity_submission.state = 'settled'
                     THEN 'settled'
                   ELSE excluded.state
                 END,
                 observed_at = MAX(
                   thread_activity_submission.observed_at,
                   excluded.observed_at
                 )`,
            )
            .bind(
              activity.threadId,
              activity.submissionId,
              activity.state,
              occurredAt,
            ),
          db
            .prepare(
              `INSERT OR IGNORE INTO thread_activity (
                 thread_id, event_key, kind, occurred_at, recorded_at
               )
               SELECT ?, ?, ?, ?, ?
               WHERE ? = 'settled'
                  OR EXISTS (
                    SELECT 1
                    FROM thread_activity_submission
                    WHERE thread_id = ?
                      AND submission_id = ?
                      AND state = 'working'
                  )`,
            )
            .bind(
              activity.threadId,
              eventKey,
              activity.kind,
              occurredAt,
              recordedAt,
              activity.state,
              activity.threadId,
              activity.submissionId,
            ),
          // Compare-and-set: the row changes, and counts as changed, only
          // when its status, last activity, or turn outcome moves. A turn
          // starting clears a failure; one settling records whether it
          // failed and, when it finished, when. MAX keeps a replayed
          // settlement from making a Thread unread again.
          db
            .prepare(
              `WITH next AS (
                 SELECT MAX(
                          last_activity_at,
                          COALESCE(
                            (SELECT occurred_at
                             FROM thread_activity
                             WHERE thread_id = ?1 AND event_key = ?2),
                            last_activity_at
                          )
                        ) AS last_activity_at,
                        CASE
                          WHEN EXISTS (
                            SELECT 1
                            FROM thread_activity_submission
                            WHERE thread_id = ?1 AND state = 'working'
                          ) THEN 'working'
                          ELSE 'idle'
                        END AS activity_status,
                        CASE
                          WHEN ?3 = 'working' THEN 0
                          WHEN ?4 = 'failed' AND NOT EXISTS (
                            SELECT 1
                            FROM thread_activity_submission
                            WHERE thread_id = ?1 AND state = 'working'
                          ) THEN 1
                          WHEN ?4 = 'completed' THEN 0
                          ELSE turn_failed
                        END AS turn_failed,
                        CASE
                          WHEN ?5 = 1
                            THEN MAX(COALESCE(turn_settled_at, ''), ?6)
                          ELSE turn_settled_at
                        END AS turn_settled_at
                 FROM threads
                 WHERE id = ?1
               )
               UPDATE threads
               SET last_activity_at = (SELECT last_activity_at FROM next),
                   activity_status = (SELECT activity_status FROM next),
                   turn_failed = (SELECT turn_failed FROM next),
                   turn_settled_at = (SELECT turn_settled_at FROM next)
               WHERE id = ?1
                 AND (last_activity_at, activity_status, turn_failed,
                      turn_settled_at) IS NOT (
                   SELECT last_activity_at, activity_status, turn_failed,
                          turn_settled_at
                   FROM next
                 )`,
            )
            .bind(
              activity.threadId,
              eventKey,
              activity.state,
              activity.outcome ?? null,
              finished ? 1 : 0,
              occurredAt,
            ),
          ...(needsYou === undefined ? [] : [needsYou]),
        ]),
      catch: (cause) => new ThreadActivityPersistenceError({ cause }),
    });
    const owner = (
      listChanged?.results[0] as { owner_user_id?: UserId } | undefined
    )?.owner_user_id;
    if (owner !== undefined)
      yield* Effect.promise(() =>
        publishUserInvalidation(bindings, owner, "needs-you.invalidated"),
      );
    // A repeated observation, such as running after queued or a retried
    // settlement, records no event and leaves the Thread row as it was:
    // there is nothing for a client to refetch.
    if (
      (recorded?.meta.changes ?? 0) === 0 &&
      (projected?.meta.changes ?? 0) === 0
    )
      return;
    // Whoever has the Thread open as a turn finishes has seen it, before
    // their lists hear the row changed.
    if (finished && (projected?.meta.changes ?? 0) > 0) {
      const watching = yield* Effect.promise(() =>
        threadPresentUsers(bindings, activity.threadId),
      );
      if (watching.size > 0)
        yield* Effect.tryPromise({
          try: () =>
            markThreadSeen(db, activity.threadId, [...watching], occurredAt),
          catch: (cause) => new ThreadActivityPersistenceError({ cause }),
        });
    }
    yield* Effect.promise(() =>
      publishRealtimeInvalidation(
        bindings,
        activity.threadId,
        "thread.invalidated",
      ),
    );
  });

export const recordFlueThreadActivity = (
  event: FlueObservation,
  context: FlueEventContext,
): Promise<void> => {
  const activity = threadActivityFromFlue(event);
  return activity === undefined
    ? Promise.resolve()
    : Effect.runPromise(
        record(context.env as Bindings, activity).pipe(Effect.asVoid),
      );
};
