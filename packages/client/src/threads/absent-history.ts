/**
 * Flue's answer for a conversation that has not started, made in the page.
 * Core answers a history read that asks 204 instead, so the browser logs no
 * error (see `ABSENT_CONVERSATION_REQUEST_HEADER`); Flue's client still
 * reads its own 404.
 */
export const absentHistoryResponse = () =>
  new Response('{"error":{"type":"stream_not_found"}}', {
    status: 404,
    headers: { "content-type": "application/json" },
  });
