import { describe, expect, it, vi } from "vitest";

const ownerRequest = vi.hoisted(() => vi.fn());
vi.mock("../threads/owner-request.js", () => ({ ownerRequest }));

const { readHistory } = await import("./history.js");

describe("readHistory", () => {
  it("keeps why each failed submission failed, as Flue settled it", async () => {
    ownerRequest.mockResolvedValueOnce({
      response: new Response(null, { status: 200 }),
      payload: {
        messages: [],
        settlements: [
          { submissionId: "sub_ok", outcome: "completed" },
          {
            submissionId: "sub_read_only",
            outcome: "failed",
            error: {
              name: "FlueError",
              type: "workspace_read_only",
              message: "The Orb's disk became read-only.",
              details:
                "dx restarted the Orb, but its disk is still read-only. Retry to restart it again.",
              meta: { code: "WORKSPACE_READ_ONLY" },
            },
          },
          {
            submissionId: "sub_internal",
            outcome: "failed",
            error: {
              type: "internal_error",
              message:
                "The agent submission failed because of an internal error.",
            },
          },
        ],
      },
    });

    const read = await readHistory({} as never, "usr_1" as never, "thr_1", 20);

    if (read.kind !== "page") throw new Error(read.kind);
    expect(read.page.settled.get("sub_read_only")).toBe("failed");
    expect(read.page.failures.get("sub_read_only")).toEqual({
      type: "workspace_read_only",
      message: "The Orb's disk became read-only.",
      details:
        "dx restarted the Orb, but its disk is still read-only. Retry to restart it again.",
      code: "WORKSPACE_READ_ONLY",
    });
    expect(read.page.failures.get("sub_internal")).toEqual({
      type: "internal_error",
      message: "The agent submission failed because of an internal error.",
    });
    expect(read.page.failures.has("sub_ok")).toBe(false);
  });
});
