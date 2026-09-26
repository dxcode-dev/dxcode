import { defaultThreadModelSelection } from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetThreadInvalidRequestResponseSchema,
  GetThreadNotFoundResponseSchema,
  GetThreadParamsSchema,
  GetThreadPersistenceUnavailableResponseSchema,
  GetThreadResponseSchema,
} from "./get-thread.js";

const threadId = "thr_00000000-0000-4000-8000-000000000073";
const thread = {
  id: threadId,
  title: "Test thread",
  projectId: "prj_00000000-0000-4000-8000-000000000072",
  visibility: "private",
  lifecycleState: "active",
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z",
  lastActivityAt: "2026-08-20T12:00:00.000Z",
  activityStatus: "idle",
  agentUrl: `/v1/agents/dx/${threadId}`,
  executionWorkspace: { ready: true, preparationStatus: null },
  agentInitialization: {
    personalInstructions: "",
    settingsRevision: 0,
    settingsVersion: 1,
    selection: defaultThreadModelSelection(),
    mcpConnections: [],
    plugins: [],
    skills: [],
  },
};

describe("Get Thread contract", () => {
  it("decodes only a canonical ThreadId parameter", () => {
    expect(
      Schema.decodeUnknownSync(GetThreadParamsSchema)({ threadId }),
    ).toEqual({
      threadId,
    });
    expect(() =>
      Schema.decodeUnknownSync(GetThreadParamsSchema)({ threadId: "invalid" }),
    ).toThrow();
  });

  it("encodes the exact public response", () => {
    const response = { status: "success" as const, data: thread };
    expect(
      Schema.encodeUnknownSync(GetThreadResponseSchema)(
        Schema.decodeUnknownSync(GetThreadResponseSchema)(response),
      ),
    ).toEqual(response);
  });

  it.each([
    [
      GetThreadInvalidRequestResponseSchema,
      "INVALID_REQUEST",
      "Request validation failed.",
    ],
    [GetThreadNotFoundResponseSchema, "THREAD_NOT_FOUND", "Thread not found."],
    [
      GetThreadPersistenceUnavailableResponseSchema,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
    ],
  ] as const)("keeps the %s error literal exact", (schema, code, message) => {
    expect(
      Schema.decodeUnknownSync(schema)({
        status: "error",
        data: { code, message, requestId: "req-thread" },
      }).data.code,
    ).toBe(code);
  });
});
