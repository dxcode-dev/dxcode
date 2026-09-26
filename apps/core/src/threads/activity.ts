import { ThreadId, Timestamp } from "@dx/domain";
import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { publishRealtimeInvalidation } from "../realtime/publication.js";

const ThreadActivityInput = Schema.Struct({
  threadId: ThreadId,
  submissionId: Schema.String.check(Schema.isMinLength(1)),
  kind: Schema.Literals(["submitted", "settled"]),
  state: Schema.Literals(["working", "settled"]),
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
    yield* Effect.tryPromise({
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
          db
            .prepare(
              `UPDATE threads
               SET last_activity_at = MAX(
                     last_activity_at,
                     COALESCE(
                       (SELECT occurred_at
                        FROM thread_activity
                        WHERE thread_id = ? AND event_key = ?),
                       last_activity_at
                     )
                   ),
                   activity_status = CASE
                     WHEN EXISTS (
                       SELECT 1
                       FROM thread_activity_submission
                       WHERE thread_id = ? AND state = 'working'
                     ) THEN 'working'
                     ELSE 'idle'
                   END
               WHERE id = ?`,
            )
            .bind(
              activity.threadId,
              eventKey,
              activity.threadId,
              activity.threadId,
            ),
        ]),
      catch: (cause) => new ThreadActivityPersistenceError({ cause }),
    });
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
