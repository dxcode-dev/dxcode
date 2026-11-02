import { ApiError } from "../api/client.js";

/** Retry once after a network failure or 5xx; never after a cancel or a 4xx. */
export const retryQuery = (failureCount: number, error: unknown) => {
  if (error instanceof DOMException && error.name === "AbortError")
    return false;
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
};
