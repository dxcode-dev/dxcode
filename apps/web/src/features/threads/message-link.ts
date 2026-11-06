import type { TranscriptRow } from "./transcript-view-model.js";

/** dx's name for a message that tags someone, which notifications link to. */
const DX_MESSAGE_ID = /^msg_[0-9a-f]{24}$/;
/** A transcript row: `row:<message id>:text:<occurrence>`. */
const ROW_ID = /^row:[\w.-]{1,160}:text:\d{1,4}$/;

/**
 * Whether `?message=` names a message the transcript can open at: a tagged
 * message's dx id, or any message's transcript row.
 */
export const isMessageLinkId = (value: unknown): value is string =>
  typeof value === "string" &&
  (DX_MESSAGE_ID.test(value) || ROW_ID.test(value));

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
export const rowMatchesMessageLink = (row: TranscriptRow, id: string) =>
  row.id === id || (row.kind === "user-prompt" && row.dxMessageId === id);

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
