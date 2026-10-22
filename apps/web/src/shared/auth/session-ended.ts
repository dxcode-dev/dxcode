import { SESSION_ENDED_CLOSE_CODE } from "@dx/api";
import { getBrowserSession } from "./auth-client.js";

/**
 * Core closes a WebSocket with `SESSION_ENDED_CLOSE_CODE` when the browser
 * session that opened it ended, here or from another browser. A socket
 * client that sees it stops reconnecting and reports it; the application
 * root then signs this browser out, which shows sign-in. A request that Core
 * refuses for want of a session reports it too (`noticeUnauthenticated`).
 */
const listeners = new Set<() => void>();

export const isSessionEndedClose = (code: number | undefined) =>
  code === SESSION_ENDED_CLOSE_CODE;

export const reportSessionEnded = () => {
  for (const listener of [...listeners]) listener();
};

/** One session check shared by every request refused at once. */
let confirming: Promise<void> | undefined;

/**
 * Signs this browser out when Core's authentication refused a request (a
 * 401 with code `UNAUTHENTICATED`) and the session check agrees: a click on
 * a session ended elsewhere shows sign-in at once. The check keeps a request
 * sent before sign-in from signing out the session that followed. Other 401s
 * (a provider rejecting a key) are not about this browser's session.
 */
export const noticeUnauthenticated = (response: Response) => {
  if (response.status !== 401 || confirming !== undefined) return;
  confirming = response
    .clone()
    .json()
    .then(async (body: unknown) => {
      const data =
        typeof body === "object" && body !== null && "data" in body
          ? body.data
          : undefined;
      if (
        typeof data !== "object" ||
        data === null ||
        !("code" in data) ||
        data.code !== "UNAUTHENTICATED"
      )
        return;
      if ((await getBrowserSession()) === null) reportSessionEnded();
    })
    .catch(() => undefined)
    .finally(() => {
      confirming = undefined;
    });
};

export const onSessionEnded = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
