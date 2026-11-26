import type {
  TranscriptRow,
  TranscriptViewModel,
  transcriptRowsByTurn,
} from "./transcript-view-model.js";

/** Message IDs a UI gives messages other Threads sent, not yet joined. */
export const INBOUND_MESSAGE_PREFIX = "inbound:";

/**
 * A prompt not in Flue's history yet, so it has no server time: the local
 * echo of a send, or a message another Thread sent.
 */
const waitingPrompt = (row: TranscriptRow) =>
  row.kind === "user-prompt" && row.sentAt === undefined;

/**
 * Where the agent is. The dot sits on the latest running turn that is more
 * than prompts waiting for the agent: prompts sent while it works wait below
 * it until the agent takes them. A message another Thread sent is its own
 * turn with its own mark, so it never holds the dot.
 */
export const transcriptProgress = (
  model: TranscriptViewModel,
  rowsByTurn: ReturnType<typeof transcriptRowsByTurn>,
) => {
  const running = model.turns.filter((turn) => {
    if (turn.status !== "active") return false;
    const rows = rowsByTurn.get(turn.id) ?? [];
    return !(
      rows.length > 0 &&
      rows.every((row) => row.messageId.startsWith(INBOUND_MESSAGE_PREFIX))
    );
  });
  const waiting = (turn: TranscriptViewModel["turns"][number]) => {
    const rows = rowsByTurn.get(turn.id) ?? [];
    return rows.length > 0 && rows.every(waitingPrompt);
  };
  const working = running.findLast((turn) => !waiting(turn));
  // Nothing else runs: a new prompt is what the agent starts on.
  return (working ?? running.at(-1))?.id;
};
