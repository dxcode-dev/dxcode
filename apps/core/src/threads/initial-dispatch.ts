import { threadAgentName } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { dispatch } from "@flue/runtime";
import { FlueError } from "@flue/runtime";
import { threadPersistenceLogger } from "../logging.js";

/**
 * A new Thread's first message, between `POST /v1/threads` answering and
 * the Thread's agent admitting it (#1590).
 *
 * Creation writes the message to `thread_initial_dispatch` in the same batch
 * as the Thread, answers with the receipt Flue will give it, and delivers it
 * after the response. Flue keys the message `initial`, so every delivery of
 * the row (the request's own, then the cron sweep's for one the request did
 * not finish) admits it once. A refusal, or a Flue that stays unavailable,
 * marks the row failed; the Thread's detail carries the failure so the
 * Thread says why it did not start.
 */

export type InitialDispatchRequest = Parameters<typeof dispatch>[1];
export type InitialDispatcher = (
  request: InitialDispatchRequest,
) => ReturnType<typeof dispatch>;

/** The key Flue admits a Thread's first message under. */
export const INITIAL_IDEMPOTENCY_KEY = "initial";

/** Attempts across the request and the sweep before the row fails. */
export const MAX_INITIAL_DISPATCH_ATTEMPTS = 6;

/**
 * The sweep takes a pending row only this long after its last attempt, so
 * it never races the request that wrote it: `waitUntil` ends 30 s after the
 * response.
 */
export const INITIAL_DISPATCH_SWEEP_AFTER_MS = 45_000;

/** Why a first message did not start, as the Thread shows it. */
export type InitialDispatchFailureCode =
  | "INITIAL_MESSAGE_REJECTED"
  | "INITIAL_MESSAGE_TOO_LARGE"
  | "INITIAL_SUBMISSION_CONFLICT"
  | "INITIAL_ADMISSION_UNAVAILABLE";

/**
 * The submission ID Flue derives for a Thread's first message, so creation
 * can answer with the receipt before the agent admits it. Mirrors Flue's
 * `deriveKeyedSubmissionId`, a frozen wire format the web client mirrors too.
 */
export const initialSubmissionId = async (threadId: ThreadId) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `flue-submission-key\n${threadAgentName}\n${threadId}\n${INITIAL_IDEMPOTENCY_KEY}`,
    ),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sub_ik_${hex.slice(0, 32)}`;
};

/** A Flue refusal that no retry changes, as the Thread names it. */
const refusalCode = (
  cause: unknown,
): InitialDispatchFailureCode | undefined => {
  if (!(cause instanceof FlueError)) return undefined;
  switch (cause.type) {
    case "invalid_request":
      return "INITIAL_MESSAGE_REJECTED";
    case "input_too_large":
      return "INITIAL_MESSAGE_TOO_LARGE";
    case "submission_conflict":
      return "INITIAL_SUBMISSION_CONFLICT";
  }
  return undefined;
};

/** The existing agent's uid when Flue says the Thread's agent exists. */
const existingAgentUid = (cause: unknown) =>
  cause instanceof FlueError &&
  cause.type === "agent_instance_exists" &&
  typeof (cause.meta as { uid?: unknown } | undefined)?.uid === "string"
    ? (cause.meta as { uid: string }).uid
    : undefined;

export interface PendingInitialDispatch {
  readonly threadId: ThreadId;
  readonly request: InitialDispatchRequest;
  readonly attachmentIds: ReadonlyArray<string>;
  readonly senderUserId: string;
  /** Attempts made before this delivery. */
  readonly attempts: number;
}

export type InitialDispatchOutcome =
  | {
      readonly kind: "admitted";
      readonly receipt: Awaited<ReturnType<InitialDispatcher>>;
      readonly acceptedAt: number;
    }
  | { readonly kind: "failed"; readonly code: InitialDispatchFailureCode }
  | { readonly kind: "pending" };

export interface InitialDispatchDelivery {
  readonly db: D1Database;
  readonly dispatch: InitialDispatcher;
  /** Links the admitted message's files to the Thread. */
  readonly linkAttachments: (pending: PendingInitialDispatch) => Promise<void>;
  /** Tells the Thread's viewers the first message failed. */
  readonly invalidate: (threadId: ThreadId) => Promise<void>;
  /** Records the admitted message as the Thread's running turn. */
  readonly recordAdmission?: (admitted: {
    readonly threadId: ThreadId;
    readonly submissionId: string;
    readonly admittedAt: number;
  }) => Promise<void>;
  /** Releases what the Thread started for the message, after a failure. */
  readonly afterFailure?: () => Promise<void>;
  /** Waits between this delivery's own attempts. */
  readonly retryDelaysMs?: ReadonlyArray<number>;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One admission try; an existing agent takes the message by its uid. */
const admit = async (
  send: InitialDispatcher,
  request: InitialDispatchRequest,
) => {
  try {
    return await send(request);
  } catch (cause) {
    const uid = existingAgentUid(cause);
    if (uid === undefined) throw cause;
    // Something started the agent first: deliver the message to it under
    // the same key, which Flue still admits once. A condition forbids
    // creation, so the creation data goes.
    const { initialData: _created, ...rest } = request;
    return await send({ ...rest, uid });
  }
};

const fail = async (
  delivery: InitialDispatchDelivery,
  pending: PendingInitialDispatch,
  code: InitialDispatchFailureCode,
  attempts: number,
): Promise<InitialDispatchOutcome> => {
  await delivery.db
    .prepare(
      `UPDATE thread_initial_dispatch
          SET state = 'failed', failure_code = ?, attempts = ?, attempted_at = ?
        WHERE thread_id = ? AND state = 'pending'`,
    )
    .bind(code, attempts, Date.now(), pending.threadId)
    .run();
  threadPersistenceLogger.warn("A new Thread's first message did not start.", {
    event: "thread_initial_dispatch_failed",
    threadId: pending.threadId,
    code,
    attempts,
  });
  await Promise.allSettled([
    delivery.invalidate(pending.threadId),
    delivery.afterFailure?.(),
  ]);
  return { kind: "failed", code };
};

/**
 * Delivers a pending first message to the Thread's agent: on admission it
 * links the message's files and deletes the row; on a refusal, or once the
 * attempts run out, it marks the row failed. A transient failure leaves the
 * row pending for the sweep.
 */
export const deliverInitialDispatch = async (
  delivery: InitialDispatchDelivery,
  pending: PendingInitialDispatch,
): Promise<InitialDispatchOutcome> => {
  const delays = delivery.retryDelaysMs ?? [];
  let attempts = pending.attempts;
  for (let attempt = 0; ; attempt++) {
    attempts++;
    try {
      const receipt = await admit(delivery.dispatch, pending.request);
      const acceptedAt = Date.now();
      // Before the row goes, so the Thread never reads idle in between.
      await delivery
        .recordAdmission?.({
          threadId: pending.threadId,
          submissionId: receipt.submissionId,
          admittedAt: acceptedAt,
        })
        .catch((cause: unknown) =>
          threadPersistenceLogger.warn(
            "A new Thread's first turn was not recorded as running.",
            {
              event: "thread_initial_dispatch_activity_failed",
              threadId: pending.threadId,
              code: cause instanceof Error ? cause.name : "UNKNOWN",
            },
          ),
        );
      await Promise.all([
        delivery.linkAttachments(pending).catch((cause: unknown) =>
          threadPersistenceLogger.warn(
            "Message attachments were not recorded.",
            {
              event: "message_attachments_record_failed",
              threadId: pending.threadId,
              code: cause instanceof Error ? cause.name : "UNKNOWN",
            },
          ),
        ),
        delivery.db
          .prepare("DELETE FROM thread_initial_dispatch WHERE thread_id = ?")
          .bind(pending.threadId)
          .run(),
      ]);
      return { kind: "admitted", receipt, acceptedAt };
    } catch (cause) {
      const refused = refusalCode(cause);
      if (refused !== undefined)
        return fail(delivery, pending, refused, attempts);
      if (attempts >= MAX_INITIAL_DISPATCH_ATTEMPTS)
        return fail(
          delivery,
          pending,
          "INITIAL_ADMISSION_UNAVAILABLE",
          attempts,
        );
      const delay = delays[attempt];
      if (delay === undefined) {
        await delivery.db
          .prepare(
            `UPDATE thread_initial_dispatch
                SET attempts = ?, attempted_at = ?
              WHERE thread_id = ? AND state = 'pending'`,
          )
          .bind(attempts, Date.now(), pending.threadId)
          .run();
        threadPersistenceLogger.warn(
          "A new Thread's first message waits for another attempt.",
          {
            event: "thread_initial_dispatch_retry",
            threadId: pending.threadId,
            code: cause instanceof Error ? cause.name : "UNKNOWN",
            attempts,
          },
        );
        return { kind: "pending" };
      }
      await pause(delay);
    }
  }
};

interface PendingRow {
  readonly thread_id: ThreadId;
  readonly request_json: string;
  readonly attachment_ids_json: string;
  readonly sender_user_id: string;
  readonly attempts: number;
}

const pendingFromRow = (row: PendingRow): PendingInitialDispatch => ({
  threadId: row.thread_id,
  request: JSON.parse(row.request_json) as InitialDispatchRequest,
  attachmentIds: JSON.parse(row.attachment_ids_json) as string[],
  senderUserId: row.sender_user_id,
  attempts: row.attempts,
});

/**
 * Delivers first messages whose request ended before their agent admitted
 * them: the Worker was evicted, or Flue was unavailable for every attempt
 * the request made. Runs on every cron tick.
 */
export const sweepInitialDispatches = async (
  delivery: Omit<InitialDispatchDelivery, "afterFailure" | "retryDelaysMs">,
  now: number,
  limit = 20,
) => {
  const { results } = await delivery.db
    .prepare(
      `SELECT thread_id, request_json, attachment_ids_json, sender_user_id, attempts
         FROM thread_initial_dispatch
        WHERE state = 'pending'
          AND COALESCE(attempted_at, created_at) <= ?
        ORDER BY created_at
        LIMIT ?`,
    )
    .bind(now - INITIAL_DISPATCH_SWEEP_AFTER_MS, limit)
    .all<PendingRow>();
  const outcomes = await Promise.all(
    results.map((row) =>
      deliverInitialDispatch(delivery, pendingFromRow(row)).catch(
        (): InitialDispatchOutcome => ({ kind: "pending" }),
      ),
    ),
  );
  return outcomes;
};

/** A Thread's first message still on its way to the agent, if any. */
export const readPendingInitialDispatch = async (
  db: D1Database,
  threadId: ThreadId,
) => {
  const row = await db
    .prepare(
      `SELECT thread_id, request_json, attachment_ids_json, sender_user_id, attempts
         FROM thread_initial_dispatch
        WHERE thread_id = ? AND state = 'pending'`,
    )
    .bind(threadId)
    .first<PendingRow>();
  return row === null ? undefined : pendingFromRow(row);
};

/**
 * The owner's Retry on a first message that failed to start: flips the row
 * back to pending, only for the active Thread's owner and only once however
 * often Retry is pressed, then delivers it under the same key. `undefined`
 * when the Thread is not the owner's; `absent` when there is nothing to
 * retry.
 */
export const retryInitialDispatch = async (
  delivery: InitialDispatchDelivery,
  threadId: ThreadId,
  ownerUserId: string,
): Promise<
  InitialDispatchOutcome | { readonly kind: "absent" } | undefined
> => {
  const [flipped, owned] = await delivery.db.batch([
    delivery.db
      .prepare(
        `UPDATE thread_initial_dispatch
            SET state = 'pending', failure_code = NULL, attempts = 0,
                attempted_at = NULL
          WHERE thread_id = ?1 AND state = 'failed'
            AND EXISTS (SELECT 1 FROM threads
                         WHERE id = ?1 AND owner_user_id = ?2
                           AND lifecycle_state = 'active')`,
      )
      .bind(threadId, ownerUserId),
    delivery.db
      .prepare(
        `SELECT d.state AS state, d.failure_code AS failureCode
           FROM threads AS t
           LEFT JOIN thread_initial_dispatch AS d ON d.thread_id = t.id
          WHERE t.id = ? AND t.owner_user_id = ?`,
      )
      .bind(threadId, ownerUserId),
  ]);
  const row = (
    owned?.results as
      | Array<{ state: string | null; failureCode: string | null }>
      | undefined
  )?.[0];
  if (row === undefined) return undefined;
  if ((flipped?.meta.changes ?? 0) === 0) {
    if (row.state === "pending") return { kind: "pending" };
    if (row.state === "failed")
      return {
        kind: "failed",
        code: (row.failureCode ??
          "INITIAL_ADMISSION_UNAVAILABLE") as InitialDispatchFailureCode,
      };
    return { kind: "absent" };
  }
  const pending = await readPendingInitialDispatch(delivery.db, threadId);
  if (pending === undefined) return { kind: "absent" };
  threadPersistenceLogger.info("A first message is retried by its owner.", {
    event: "thread_initial_dispatch_retried",
    threadId,
  });
  return deliverInitialDispatch(delivery, pending);
};

/** A Thread's first message that has not started, for its detail. */
interface InitialDispatchStateRow {
  readonly state: "pending" | "failed";
  readonly failureCode: InitialDispatchFailureCode | null;
}

export const initialDispatchStateStatement = (
  db: D1Database,
  threadId: ThreadId,
) =>
  db
    .prepare(
      `SELECT state, failure_code AS failureCode
         FROM thread_initial_dispatch WHERE thread_id = ?`,
    )
    .bind(threadId);

/** The first message's admission, from a batched read's first row. */
export const initialDispatchStateOf = (row: unknown) =>
  (row ?? null) as InitialDispatchStateRow | null;

export const readInitialDispatchState = async (
  db: D1Database,
  threadId: ThreadId,
) =>
  initialDispatchStateStatement(db, threadId).first<InitialDispatchStateRow>();
