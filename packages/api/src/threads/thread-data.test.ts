import { defaultThreadModelSelection, ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ArchiveThreadRequestSchema,
  ArchiveThreadResponseSchema,
  ThreadArchivedResponseSchema,
} from "./archive-thread.js";
import {
  ThreadAgentUrlSchema,
  ThreadDataSchema,
  ThreadDetailDataSchema,
  threadAgentUrl,
} from "./thread-data.js";

const threadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000092",
);
const otherThreadId = Schema.decodeUnknownSync(ThreadId)(
  "thr_00000000-0000-4000-8000-000000000093",
);
const thread = {
  id: threadId,
  title: "Test thread",
  projectId: "prj_00000000-0000-4000-8000-000000000091",
  visibility: "private" as const,
  createdAt: "2026-08-21T12:00:00.000Z",
  updatedAt: "2026-08-21T12:00:00.000Z",
  lastActivityAt: "2026-08-21T12:00:00.000Z",
  activityStatus: "idle" as const,
  lifecycleState: "active" as const,
  agentUrl: "/v1/agents/dx/thr_00000000-0000-4000-8000-000000000092",
};
const threadDetail = {
  ...thread,
  executionWorkspace: { ready: true, preparationStatus: null },
  agentInitialization: {
    personalInstructions: "Prefer focused tests.",
    settingsRevision: 4,
    settingsVersion: 1,
    selection: defaultThreadModelSelection(),
    mcpConnections: [],
    plugins: [],
    skills: [],
  },
};

describe("Thread public data", () => {
  it("constructs the independently asserted relative agent URL", () => {
    expect(threadAgentUrl(threadId)).toBe(
      "/v1/agents/dx/thr_00000000-0000-4000-8000-000000000092",
    );
    expect(
      Schema.decodeUnknownSync(ThreadAgentUrlSchema)(thread.agentUrl),
    ).toBe(thread.agentUrl);
  });

  it("round-trips exact public data when id and agentUrl agree", () => {
    const decoded = Schema.decodeUnknownSync(ThreadDataSchema)(thread);
    expect(Schema.encodeUnknownSync(ThreadDataSchema)(decoded)).toEqual(thread);
  });

  it("keeps immutable agent initialization only on Thread detail data", () => {
    const decoded = Schema.decodeUnknownSync(ThreadDetailDataSchema)(
      threadDetail,
    );
    expect(Schema.encodeUnknownSync(ThreadDetailDataSchema)(decoded)).toEqual(
      threadDetail,
    );
    expect(Schema.encodeUnknownSync(ThreadDataSchema)(decoded)).toEqual(thread);
  });

  it("rejects a different valid ThreadId in agentUrl on decode and encode", () => {
    const mismatchedAgentUrl = threadAgentUrl(otherThreadId);
    expect(() =>
      Schema.decodeUnknownSync(ThreadDataSchema)({
        ...thread,
        agentUrl: mismatchedAgentUrl,
      }),
    ).toThrow();

    const decoded = Schema.decodeUnknownSync(ThreadDataSchema)(thread);
    expect(() =>
      Schema.encodeUnknownSync(ThreadDataSchema)({
        ...decoded,
        agentUrl: mismatchedAgentUrl,
      }),
    ).toThrow();
  });
});

describe("Thread archive API", () => {
  it("round-trips archive state and the archived execution denial", () => {
    expect(
      Schema.decodeUnknownSync(ArchiveThreadRequestSchema)({ archived: true }),
    ).toEqual({ archived: true });
    expect(
      Schema.encodeUnknownSync(ArchiveThreadResponseSchema)(
        Schema.decodeUnknownSync(ArchiveThreadResponseSchema)({
          status: "success",
          data: { ...thread, lifecycleState: "archived" },
        }),
      ),
    ).toEqual({
      status: "success",
      data: { ...thread, lifecycleState: "archived" },
    });
    expect(
      Schema.decodeUnknownSync(ThreadArchivedResponseSchema)({
        status: "error",
        data: {
          code: "THREAD_ARCHIVED",
          message: "Thread is archived. Unarchive it before continuing.",
          requestId: "request-archive",
        },
      }),
    ).toMatchObject({ data: { code: "THREAD_ARCHIVED" } });
  });

  it("rejects non-boolean lifecycle mutation input", () => {
    expect(() =>
      Schema.decodeUnknownSync(ArchiveThreadRequestSchema)({ archived: "yes" }),
    ).toThrow();
  });
});
