import type { FlueObservation } from "@flue/runtime";
import { readOrbThreadState } from "../../agents/orb-free.js";
import type { Bindings } from "../../http/types.js";
import { spaceLogger } from "../../logging.js";
import { announcePosts } from "./effects.js";
import { clearAgentEyes } from "./store.js";

/**
 * Ends dx's `eyes` on a Space's posts when the agent's turn that received
 * them ends, however it ended: the posts that reached the settled
 * submission lose it, and once the Space is no longer working, every post
 * does (a message steered into a running turn settles with it). Runs after
 * the observation's Thread activity is recorded. Never rejects.
 */
export const clearSpaceEyesOnSettle = async (
  bindings: Bindings,
  event: FlueObservation,
): Promise<void> => {
  const db = (bindings as Bindings | undefined)?.DB;
  const threadId = event.instanceId;
  if (
    db === undefined ||
    threadId === undefined ||
    event.type !== "submission_settled"
  )
    return;
  try {
    if ((await readOrbThreadState(db, threadId)).kind !== "space") return;
    const working =
      (await db
        .prepare("SELECT activity_status FROM threads WHERE id = ?")
        .bind(threadId)
        .first<string>("activity_status")) === "working";
    const cleared = await clearAgentEyes(
      db,
      threadId,
      working ? event.submissionId : undefined,
    );
    if (cleared > 0) await announcePosts(bindings, threadId);
  } catch (cause) {
    spaceLogger.warn("A Space's eyes were not cleared.", {
      event: "space_eyes_clear_failed",
      threadId,
      cause,
    });
  }
};
