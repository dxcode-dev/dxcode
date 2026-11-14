import { deliverMessage } from "../automations/wake.js";
import type { Bindings } from "../http/types.js";
import { settingsPersistenceLogger } from "../logging.js";

/**
 * Wakes the Thread whose agent proposed a skill or plugin once a person
 * decides the proposal on its Settings page, so the agent hears the outcome
 * without an ask in an artifact. Best effort: the decision already stands.
 */
export const wakeOnProposalDecided = async (
  bindings: Bindings,
  input: {
    readonly threadId: string;
    readonly proposalId: string;
    readonly what: "skill" | "plugin";
    readonly outcome: string;
  },
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  const db = bindings.DB;
  if (db === undefined) return;
  try {
    const owner = await db
      .prepare(
        "SELECT owner_user_id FROM threads WHERE id = ? AND lifecycle_state != 'archived'",
      )
      .bind(input.threadId)
      .first<{ owner_user_id: string }>();
    if (owner === null) return;
    await deliverMessage(
      {
        bindings,
        ownerUserId: owner.owner_user_id,
        automation: "settings",
        ...(waitUntil === undefined ? {} : { waitUntil }),
      },
      input.threadId,
      `The owner decided your ${input.what} proposal ${input.proposalId} in Settings: ${input.outcome} Carry on with what the decision unblocks.`,
      `proposal-decided:${input.proposalId}`,
    );
  } catch (cause) {
    settingsPersistenceLogger.warn("Proposal decision wake failed.", {
      event: "settings_proposal_decided_wake_failed",
      threadId: input.threadId,
      proposalId: input.proposalId,
      cause,
    });
  }
};
