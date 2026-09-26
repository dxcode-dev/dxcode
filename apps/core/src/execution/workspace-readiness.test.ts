import type { ThreadId } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";
import { readExecutionWorkspaceReadiness } from "./workspace-readiness.js";

describe("readExecutionWorkspaceReadiness", () => {
  it("returns not ready when the workspace row does not exist", async () => {
    const first = vi.fn(async () => null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;
    const threadId = "thr_00000000-0000-4000-8000-000000000398" as ThreadId;

    await expect(
      readExecutionWorkspaceReadiness(db, threadId),
    ).resolves.toEqual({
      ready: false,
      preparationStatus: null,
    });
    expect(bind).toHaveBeenCalledWith(threadId);
  });
});
