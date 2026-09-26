import type { UserId } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";
import {
  BitbucketApiError,
  bitbucketConnectionQueryOptions,
} from "./bitbucket-queries.js";

const userId = "user-1" as UserId;

describe("Bitbucket queries", () => {
  it.each([
    [503, "BITBUCKET_UNAVAILABLE"],
    [400, "BITBUCKET_INVALID"],
    [403, "BITBUCKET_FORBIDDEN"],
  ])("preserves typed %s failures", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "error",
            data: {
              code,
              message:
                code === "BITBUCKET_UNAVAILABLE"
                  ? "Bitbucket is temporarily unavailable. Retry without disconnecting."
                  : code === "BITBUCKET_INVALID"
                    ? "The Bitbucket request is invalid or expired. Start again."
                    : "Bitbucket access is unavailable. Reconnect or check repository permissions.",
              requestId: "request-1",
            },
          }),
          { status },
        ),
      ),
    );

    const queryFn = bitbucketConnectionQueryOptions(userId).queryFn;
    let failure: unknown;
    try {
      await queryFn?.({ signal: new AbortController().signal } as never);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBeInstanceOf(BitbucketApiError);
    expect(failure).toMatchObject({
      _tag: "BitbucketApiError",
      status,
      code,
      requestId: "request-1",
    });
    vi.unstubAllGlobals();
  });
});
