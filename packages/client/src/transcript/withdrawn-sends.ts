import type { FlueConversationSettlement } from "@flue/sdk";

/** Flue's words for a message its sender took out of the queue. */
const WITHDRAWN_MESSAGE = "Submission was withdrawn before the agent read it.";

/**
 * Flue settles a message its sender withdrew from the queue as aborted with
 * this error: the agent never read it, so it is neither a failed nor a
 * stopped turn.
 */
export const isWithdrawnSettlement = ({
  outcome,
  error,
}: Pick<FlueConversationSettlement, "outcome" | "error">) =>
  outcome === "aborted" &&
  typeof error === "object" &&
  error !== null &&
  (("type" in error && error.type === "submission_withdrawn") ||
    ("message" in error && error.message === WITHDRAWN_MESSAGE));
