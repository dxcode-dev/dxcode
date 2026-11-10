/**
 * A Thread's agent has no conversation until its first message, as a new
 * Space has none until someone writes in it. Flue answers its history 404,
 * which the browser logs as an error each time the page opens. The page
 * sends `ABSENT_CONVERSATION_REQUEST_HEADER` with its history reads; Core
 * then answers a Thread the reader may read, whose conversation has not
 * started and is not about to, `204` with
 * `ABSENT_CONVERSATION_RESPONSE_HEADER: absent`. Other callers keep Flue's
 * 404.
 */
export const ABSENT_CONVERSATION_REQUEST_HEADER = "x-dx-absent-conversation";
export const ABSENT_CONVERSATION_RESPONSE_HEADER = "x-dx-conversation";
