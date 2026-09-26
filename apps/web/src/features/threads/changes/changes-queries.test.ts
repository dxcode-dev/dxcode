import { ThreadId, UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { threadKeys } from "../thread-queries.js";
import type { ChangesTransport } from "./changes-api.js";
import { changesKeys, pushChangesMutationOptions } from "./changes-queries.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000001",
);

describe("Changes mutations", () => {
  it("invalidates Thread-list projections after a successful push", async () => {
    const client = new QueryClient();
    const changesKey = changesKeys.range(threadId, { kind: "all" });
    const listKey = threadKeys.list(userId);
    client.setQueryData(changesKey, { kind: "changes" });
    client.setQueryData(listKey, { pages: [] });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const transport = {
      push: vi.fn().mockResolvedValue({}),
    } as unknown as ChangesTransport;
    const mutation = client
      .getMutationCache()
      .build(client, pushChangesMutationOptions(client, transport, threadId));

    await mutation.execute({
      expectedCaptureId: "capture-1" as never,
      idempotencyKey: "push-1",
    });

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: changesKeys.all(threadId),
    });
    expect(invalidate).toHaveBeenCalledWith({
      predicate: expect.any(Function),
    });
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});
