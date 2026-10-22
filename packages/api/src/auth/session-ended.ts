/**
 * The WebSocket close code Core sends when the browser session that opened a
 * socket ended: signed out, ended from Security settings, expired, or its
 * user deleted. The client goes to sign-in instead of reconnecting.
 */
export const SESSION_ENDED_CLOSE_CODE = 4401;
export const SESSION_ENDED_CLOSE_REASON = "session-ended";
