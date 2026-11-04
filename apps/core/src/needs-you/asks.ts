import type { NeedsYouAsk } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { publishRealtimeInvalidation } from "../realtime/publication.js";
import { threadProjectReachableSql } from "../settings/members/membership-sql.js";
import {
  artifactSaved,
  askItemKey,
  type DeliverArtifactWake,
} from "../thread-artifacts/ask-effects.js";
import { checklistItems } from "../thread-artifacts/asks.js";
import { readArtifact, saveArtifact } from "../thread-artifacts/store.js";
import {
  findSharedThreadGrant,
  sharedThreadAccessSql,
  sharedThreadVisibleSql,
} from "../thread-sharing/access.js";

/**
 * Asks in artifacts on the Needs-you page (`artifact-asks` flag): unchecked
 * checklist items that mention the person, across the Threads they can
 * open, from the index each save rebuilds (`thread_artifact_ask`).
 */

const ASK_LIMIT = 200;

/** The person's open asks in live Threads they can open, oldest first. */
export const listArtifactAsks = async (
  db: D1Database,
  userId: UserId,
  now = new Date(),
): Promise<ReadonlyArray<NeedsYouAsk>> => {
  const { results } = await db
    .prepare(
      `SELECT ask.thread_id, thread.title AS thread_title, ask.artifact_id,
              artifact.title AS artifact_title, ask.item_key, ask.text,
              ask.revision, ask.waiting_since,
              CASE WHEN thread.owner_user_id = ?1 THEN 'owner'
                   ELSE ${sharedThreadAccessSql("thread", "?2")} END AS access
         FROM thread_artifact_ask AS ask
         JOIN thread_artifact AS artifact
           ON artifact.id = ask.artifact_id AND artifact.deleted_at IS NULL
         JOIN threads AS thread ON thread.id = ask.thread_id
         JOIN projects AS project ON project.id = thread.project_id
        WHERE ask.mentioned_user_id = ?1
          AND thread.lifecycle_state = 'active'
          AND ((thread.owner_user_id = ?1
                AND ${threadProjectReachableSql("project", "?1")})
               OR ${sharedThreadVisibleSql("thread", "project", "?1")})
        ORDER BY ask.waiting_since, ask.artifact_id, ask.line
        LIMIT ${ASK_LIMIT}`,
    )
    .bind(userId, now.toISOString())
    .all<{
      thread_id: ThreadId;
      thread_title: string;
      artifact_id: string;
      artifact_title: string;
      item_key: string;
      text: string;
      revision: number;
      waiting_since: number;
      access: "owner" | "contribute" | "view";
    }>();
  return results.map((row) => ({
    threadId: row.thread_id,
    threadTitle: row.thread_title.slice(0, 256),
    artifactId: row.artifact_id,
    artifactTitle: row.artifact_title,
    itemKey: row.item_key,
    text: row.text,
    revision: row.revision,
    waitingSince: row.waiting_since,
    canTick: row.access !== "view",
  }));
};

export type TickAskResult =
  | { readonly kind: "ticked"; readonly revision: number }
  | { readonly kind: "not-found" }
  | { readonly kind: "read-only" };

/** Who the person is to the Thread: its owner, a member, or nobody. */
const accessOf = async (db: D1Database, threadId: string, userId: string) => {
  const owner = await db
    .prepare(
      "SELECT owner_user_id FROM threads WHERE id = ? AND lifecycle_state = 'active'",
    )
    .bind(threadId)
    .first<string>("owner_user_id");
  if (owner === null) return undefined;
  if (owner === userId) return "owner" as const;
  return (await findSharedThreadGrant(db, threadId, userId))?.access;
};

/**
 * Ticks an ask as the person: only its checkbox changes, saved as their
 * revision through the artifact's compare-and-swap, retried if someone saved
 * meanwhile. The save then wakes the Thread like a tick in the editor.
 */
export const tickArtifactAsk = async (
  bindings: Bindings,
  input: {
    readonly userId: UserId;
    readonly threadId: string;
    readonly artifactId: string;
    readonly itemKey: string;
  },
  options: {
    readonly deliver?: DeliverArtifactWake;
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<TickAskResult> => {
  const db = bindings.DB;
  if (db === undefined) throw new Error("Persistence is unavailable.");
  const access = await accessOf(db, input.threadId, input.userId);
  if (access === undefined) return { kind: "not-found" };
  if (access === "view") return { kind: "read-only" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readArtifact(
      bindings,
      input.threadId,
      input.artifactId,
    );
    if (current === undefined) return { kind: "not-found" };
    let target: number | undefined;
    for (const item of checklistItems(current.markdown))
      if (
        !item.checked &&
        item.mentions.includes(input.userId) &&
        (await askItemKey(item)) === input.itemKey
      ) {
        target = item.line;
        break;
      }
    if (target === undefined) return { kind: "not-found" };
    const lines = current.markdown.split(/(\r\n|\r|\n)/);
    // `split` with a capture keeps the line breaks at odd indexes.
    const index = (target - 1) * 2;
    lines[index] = (lines[index] ?? "").replace(/\[ \]/, "[x]");
    const markdown = lines.join("");
    const result = await saveArtifact(bindings, {
      threadId: input.threadId,
      artifactId: input.artifactId,
      baseRevision: current.artifact.revision,
      markdown,
      writer: { kind: "user", userId: input.userId },
    });
    if (result.kind === "conflict") continue;
    if (result.kind !== "saved") return { kind: "not-found" };
    await publishRealtimeInvalidation(
      bindings,
      input.threadId as ThreadId,
      "artifacts.invalidated",
    );
    await artifactSaved(
      bindings,
      {
        threadId: input.threadId,
        artifactId: input.artifactId,
        title: result.value.artifact.title,
        revision: result.value.artifact.revision,
        before: result.previous,
        after: result.value.markdown,
        writer: { kind: "user", userId: input.userId },
      },
      options,
    );
    return { kind: "ticked", revision: result.value.artifact.revision };
  }
  return { kind: "not-found" };
};
