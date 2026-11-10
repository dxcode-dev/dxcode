import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { createQueryClient } from "./query-client.js";
import { retryOnMountQuery } from "./query-retry.js";

// A page that prefetches a read on boot and then mounts the same query must
// not read again when the server already refused it (a hidden or missing
// Thread), but must try again when the read failed for a reason that may
// pass, so a network blip during boot still recovers on mount.
const mountAfterFailedPrefetch = async (error: unknown) => {
  const client = createQueryClient();
  let reads = 0;
  const options = {
    queryKey: ["probe"],
    queryFn: async () => {
      reads += 1;
      if (reads === 1) throw error;
      return "ok";
    },
    retry: false,
    retryOnMount: retryOnMountQuery,
  } as const;
  await client.prefetchQuery(options);
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  unsubscribe();
  client.clear();
  return reads;
};

describe("retryOnMountQuery", () => {
  it("does not read again on mount after the server refused the read", async () => {
    expect(
      await mountAfterFailedPrefetch(
        new ApiError(404, "Thread not found.", "THREAD_NOT_FOUND"),
      ),
    ).toBe(1);
    expect(
      await mountAfterFailedPrefetch(new ApiError(403, "Forbidden.")),
    ).toBe(1);
  });

  it("reads again on mount after a server error or a failed request", async () => {
    expect(
      await mountAfterFailedPrefetch(new ApiError(503, "Unavailable.")),
    ).toBe(2);
    expect(
      await mountAfterFailedPrefetch(new TypeError("Failed to fetch")),
    ).toBe(2);
  });
});
