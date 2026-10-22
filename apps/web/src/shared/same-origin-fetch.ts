import { noticeUnauthenticated } from "./auth/session-ended.js";

export const sameOriginFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, credentials: "same-origin" });
  noticeUnauthenticated(response);
  return response;
};
