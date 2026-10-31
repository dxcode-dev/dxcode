import { noticeUnauthenticated } from "./auth/session-ended.js";
import { observeRequest } from "./diagnostics/client-diagnostics.js";

/** The request's path, as the failed-request log records it. */
const requestPath = (input: RequestInfo | URL) => {
  try {
    return new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    ).pathname;
  } catch {
    return "";
  }
};

export const sameOriginFetch: typeof fetch = async (input, init) => {
  const response = await observeRequest(
    requestPath(input),
    init?.method ?? (input instanceof Request ? input.method : undefined),
    () => fetch(input, { ...init, credentials: "same-origin" }),
  );
  noticeUnauthenticated(response);
  return response;
};
