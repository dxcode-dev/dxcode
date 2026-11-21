import { threadPersistenceLogger } from "../logging.js";

/**
 * A person deleted a message the agent had read, so the conversation went
 * back to just before it. The next message the agent receives is tagged
 * `rewound="true"`: work it no longer remembers may have changed files, and
 * Claude Code forks its session at the last turn it keeps.
 */
export const markThreadRewound = async (db: D1Database, threadId: string) => {
  const previous = await pendingThreadRewind(db, threadId);
  const at = Math.max(Date.now(), (previous ?? 0) + 1);
  await db
    .prepare("UPDATE threads SET history_rewound_at = ? WHERE id = ?")
    .bind(at, threadId)
    .run();
  return { at, previous };
};

/**
 * The rewind a mark was set for did not happen: the mark goes back to what
 * it was, unless something set it again meanwhile.
 */
export const unmarkThreadRewound = (
  db: D1Database,
  threadId: string,
  mark: { readonly at: number; readonly previous: number | undefined },
) =>
  db
    .prepare(
      "UPDATE threads SET history_rewound_at = ? WHERE id = ? AND history_rewound_at = ?",
    )
    .bind(mark.previous ?? null, threadId, mark.at)
    .run();

/** When the Thread was last rewound by a delete its agent has not heard of. */
export const pendingThreadRewind = async (
  db: D1Database,
  threadId: string,
): Promise<number | undefined> => {
  const row = await db
    .prepare("SELECT history_rewound_at FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ history_rewound_at: number | null }>();
  return row?.history_rewound_at ?? undefined;
};

/**
 * The tagged message reached the agent: the flag is spent, unless another
 * delete set it again meanwhile.
 */
export const clearThreadRewind = (
  db: D1Database,
  threadId: string,
  rewoundAt: number,
) =>
  db
    .prepare(
      "UPDATE threads SET history_rewound_at = NULL WHERE id = ? AND history_rewound_at <= ?",
    )
    .bind(threadId, rewoundAt)
    .run()
    .then(
      () => undefined,
      (cause) =>
        threadPersistenceLogger.warn(
          "A Thread's rewind mark was not cleared.",
          {
            event: "thread_rewind_clear_failed",
            threadId,
            cause,
          },
        ),
    );
