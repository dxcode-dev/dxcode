/**
 * Notify agent's wakes, coalesced (#1765). With a person's flag on, a Notify
 * or a comment that mentions @dx wakes the agent right away and opens a
 * window for its Thread; Notifies and mentions inside the window join one
 * trailing wake, which the minute sweep sends once the window has closed
 * (`sweepArtifactAgentWakes` in `ask-effects.ts`). So a burst of clicks or
 * mentions costs the owner's plan at most two turns per window, and every
 * mention still reaches the agent.
 */

/** How long a leading wake's window stays open for others to join. */
export const ARTIFACT_AGENT_WINDOW_MS = 15_000;

/** An event that joined a window, as `thread_artifact_agent_wake.joined` holds it. */
export type JoinedAgentEvent =
  | { readonly kind: "comment"; readonly id: string }
  | {
      readonly kind: "notify";
      readonly artifactId: string;
      readonly userId: string;
    };

/**
 * True when `event` opens a new window, so its wake goes now; false when it
 * joined the open window (or one that closed but still owes its trailing
 * wake), so the sweep's trailing wake carries it.
 */
export const leadOrJoinAgentWake = async (
  db: D1Database,
  threadId: string,
  event: JoinedAgentEvent,
  now: number,
) => {
  const opened = await db
    .prepare(
      `INSERT INTO thread_artifact_agent_wake (thread_id, window_start)
       VALUES (?1, ?2)
       ON CONFLICT (thread_id) DO UPDATE SET
         window_start = excluded.window_start,
         joined = '[]',
         trailing_sent = 0
        WHERE thread_artifact_agent_wake.window_start <= ?3
          AND (thread_artifact_agent_wake.joined = '[]'
               OR thread_artifact_agent_wake.trailing_sent = 1)
       RETURNING thread_id`,
    )
    .bind(threadId, now, now - ARTIFACT_AGENT_WINDOW_MS)
    .first<string>("thread_id");
  if (opened !== null) return true;
  await db
    .prepare(
      `UPDATE thread_artifact_agent_wake
          SET joined = json_insert(joined, '$[#]', json(?2))
        WHERE thread_id = ?1`,
    )
    .bind(threadId, JSON.stringify(event))
    .run();
  return false;
};

/** A closed window that owes a trailing wake, claimed by one sweep. */
export interface ClaimedAgentWindow {
  readonly threadId: string;
  readonly windowStart: number;
  readonly joined: ReadonlyArray<JoinedAgentEvent>;
}

const parseJoined = (text: string): ReadonlyArray<JoinedAgentEvent> => {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as JoinedAgentEvent[]) : [];
  } catch {
    return [];
  }
};

/**
 * Claims the closed windows that owe a trailing wake: each is marked sent as
 * it is read, so a second sweep finds nothing and an event after it opens a
 * new window instead of joining one already on its way.
 */
export const claimClosedAgentWindows = async (
  db: D1Database,
  now: number,
): Promise<ReadonlyArray<ClaimedAgentWindow>> => {
  const due = (
    await db
      .prepare(
        `SELECT thread_id, window_start FROM thread_artifact_agent_wake
          WHERE trailing_sent = 0 AND joined <> '[]' AND window_start <= ?1
          ORDER BY window_start
          LIMIT 50`,
      )
      .bind(now - ARTIFACT_AGENT_WINDOW_MS)
      .all<{ thread_id: string; window_start: number }>()
  ).results;
  const claimed: ClaimedAgentWindow[] = [];
  for (const row of due) {
    const joined = await db
      .prepare(
        `UPDATE thread_artifact_agent_wake SET trailing_sent = 1
          WHERE thread_id = ?1 AND window_start = ?2 AND trailing_sent = 0
          RETURNING joined`,
      )
      .bind(row.thread_id, row.window_start)
      .first<string>("joined");
    if (joined !== null)
      claimed.push({
        threadId: row.thread_id,
        windowStart: row.window_start,
        joined: parseJoined(joined),
      });
  }
  return claimed;
};

/** A trailing wake that failed to send owes it again, unless a new window opened. */
export const releaseAgentWindow = (
  db: D1Database,
  window: ClaimedAgentWindow,
) =>
  db
    .prepare(
      `UPDATE thread_artifact_agent_wake SET trailing_sent = 0
        WHERE thread_id = ?1 AND window_start = ?2`,
    )
    .bind(window.threadId, window.windowStart)
    .run();
