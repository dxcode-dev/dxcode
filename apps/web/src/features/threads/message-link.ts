import type { TranscriptRow } from "./transcript-view-model.js";

/** dx's name for a message that tags someone, which notifications link to. */
const DX_MESSAGE_ID = /^msg_[0-9a-f]{24}$/;
/** A transcript row: `row:<message id>:text:<occurrence>`. */
const ROW_ID = /^row:[\w.-]{1,160}:text:\d{1,4}$/;
/**
 * The agent's tool call, by its id: `call:<tool call id>`. The agent's
 * notification links here, as it cannot know the message it is in.
 */
const TOOL_CALL = /^call:([\w.-]{1,160})$/;

/**
 * Whether `?message=` names a message the transcript can open at: a tagged
 * message's dx id, any message's transcript row, or an agent's tool call.
 */
export const isMessageLinkId = (value: unknown): value is string =>
  typeof value === "string" &&
  (DX_MESSAGE_ID.test(value) || ROW_ID.test(value) || TOOL_CALL.test(value));

/**
 * The `?message=` value a link to this row opens. A message Flue has not
 * admitted yet has no lasting id, so it has none.
 */
export const messageLinkId = (row: TranscriptRow) => {
  if (row.kind === "user-prompt") {
    if (!row.admitted) return undefined;
    if (row.dxMessageId !== undefined) return row.dxMessageId;
  }
  return ROW_ID.test(row.id) ? row.id : undefined;
};

/** Whether a transcript row is the one a `?message=` value names. */
const rowMatchesMessageLink = (row: TranscriptRow, id: string) =>
  row.id === id || (row.kind === "user-prompt" && row.dxMessageId === id);

/**
 * The row a `?message=` value opens at. A tool call renders inside its
 * turn's collapsible work, which has no row to show, so its link opens at
 * the turn's reply, else at the prompt that started the turn.
 */
export const messageLinkRow = (
  rows: ReadonlyArray<TranscriptRow>,
  id: string,
) => {
  const call = TOOL_CALL.exec(id)?.[1];
  if (call === undefined)
    return rows.find((row) => rowMatchesMessageLink(row, id));
  const turnId = rows.find((row) => row.id.includes(`:tool:${call}:`))?.turnId;
  const turn = rows.filter((row) => row.turnId === turnId);
  return (
    turn.findLast(
      ({ kind }) => kind === "assistant-prose" || kind === "final-answer",
    ) ?? turn[0]
  );
};

/**
 * The URL that opens this page's Thread at a message (`messageLinkId`), or
 * nothing off a Thread page. Read from the location, not the router: the
 * transcript also renders outside one.
 */
export const messageLinkUrl = (linkId: string) => {
  const threadId = /^\/threads\/([^/]+)/.exec(window.location.pathname)?.[1];
  if (threadId === undefined) return undefined;
  return new URL(
    `/threads/${threadId}?message=${encodeURIComponent(linkId)}`,
    window.location.href,
  ).href;
};
