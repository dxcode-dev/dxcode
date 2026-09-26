import { defaultThreadModelSelection } from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CreateThreadInvalidRequestResponseSchema,
  CreateThreadPersistenceUnavailableResponseSchema,
  CreateThreadProjectlessForbiddenResponseSchema,
  CreateThreadProjectNotFoundResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  CreateThreadRunnerUnavailableResponseSchema,
  FLUE_MAX_IMAGE_DATA_LENGTH,
  InitialThreadMessageSchema,
} from "./create-thread.js";

const strict = { onExcessProperty: "error" } as const;
const projectId = "prj_00000000-0000-4000-8000-000000000072";
const threadId = "thr_00000000-0000-4000-8000-000000000073";
const thread = {
  id: threadId,
  title: "Test thread",
  projectId,
  visibility: "workspace",
  lifecycleState: "active",
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z",
  lastActivityAt: "2026-08-20T12:00:00.000Z",
  activityStatus: "idle",
  agentUrl: `/v1/agents/dx/${threadId}`,
  executionWorkspace: { ready: false, preparationStatus: null },
  agentInitialization: {
    personalInstructions: "Prefer focused tests.",
    settingsRevision: 2,
    settingsVersion: 1,
    selection: defaultThreadModelSelection(),
    mcpConnections: [],
    plugins: [],
    skills: [],
  },
};

describe("Create Thread contract", () => {
  it("accepts either an owned Project reference or No Project", () => {
    expect(
      Schema.decodeUnknownSync(
        CreateThreadRequestSchema,
        strict,
      )({ projectId, title: "Test thread" }),
    ).toEqual({ projectId, title: "Test thread" });
    expect(
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({ projectId }),
    ).toEqual({ projectId });
    expect(Schema.decodeUnknownSync(CreateThreadRequestSchema)({})).toEqual({});
    expect(
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        title: "Test thread",
        selection: { kind: "mode", profileId: "default", mode: "ultra" },
      }),
    ).toEqual({
      projectId,
      title: "Test thread",
      selection: { kind: "mode", profileId: "default", mode: "ultra" },
    });
    expect(
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        threadId,
        initialMessage: {
          body: "Build the durable handoff.",
          attachments: [
            {
              type: "image",
              data: "iVBORw0KGgo=",
              mimeType: "image/png",
              filename: "handoff.png",
            },
          ],
        },
      }),
    ).toMatchObject({
      initialMessage: {
        body: "Build the durable handoff.",
        attachments: [{ type: "image", mimeType: "image/png" }],
      },
    });
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        title: "Test thread",
        selection: { kind: "mode", profileId: "default", mode: "maximum" },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        selection: { kind: "model", model: "openai/gpt-6-astra" },
      }),
    ).toEqual({
      projectId,
      selection: { kind: "model", model: "openai/gpt-6-astra" },
    });
    expect(() =>
      Schema.decodeUnknownSync(
        CreateThreadRequestSchema,
        strict,
      )({
        projectId,
        title: "Test thread",
        endpoint: "forbidden",
      }),
    ).toThrow();
  });

  it("uses Flue's per-image attachment contract for the initial prompt", () => {
    const image = {
      type: "image",
      data: "not base64!",
      mimeType: "image/avif",
      filename: "x".repeat(256),
    };
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        threadId,
        initialMessage: { body: "Prompt", attachments: [image] },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        threadId,
        initialMessage: {
          body: "Prompt",
          attachments: [{ ...image, data: "aGVsbG8\n" }],
        },
      }),
    ).toMatchObject({
      initialMessage: { attachments: [{ ...image, data: "aGVsbG8\n" }] },
    });
    expect(() =>
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "Prompt",
        attachments: [
          { ...image, data: "a".repeat(FLUE_MAX_IMAGE_DATA_LENGTH + 1) },
        ],
      }),
    ).toThrow();
  });

  it("requires a stable Thread identifier for an initial prompt", () => {
    const initialMessage = { body: "Prompt", attachments: [] };
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        initialMessage,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        threadId,
      }),
    ).toThrow();
  });

  it("allows Flue-sized initial prompts while requiring content", () => {
    const image = {
      type: "image" as const,
      mimeType: "image/png" as const,
    };
    for (const body of ["", "   \n\t"]) {
      expect(() =>
        Schema.decodeUnknownSync(InitialThreadMessageSchema)({
          body,
          attachments: [],
        }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "Prompt",
        attachments: [
          { ...image, data: "A".repeat(FLUE_MAX_IMAGE_DATA_LENGTH + 1) },
        ],
      }),
    ).toThrow();
    const smallImage = { ...image, data: "aGVsbG8=" };
    expect(
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "a".repeat(64 * 1024 + 1),
        attachments: Array.from({ length: 10 }, () => smallImage),
      }),
    ).toMatchObject({
      body: "a".repeat(64 * 1024 + 1),
      attachments: Array.from({ length: 10 }, () => smallImage),
    });
    expect(() =>
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "Prompt",
        attachments: Array.from({ length: 11 }, () => smallImage),
      }),
    ).toThrow();
    const imageData = "A".repeat(8 * 1024 * 1024);
    expect(
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "Prompt",
        attachments: [
          { ...image, data: imageData },
          { ...image, data: imageData },
        ],
      }).attachments,
    ).toHaveLength(2);
    expect(
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "",
        attachments: [{ ...image, data: "aGVsbG8=" }],
      }),
    ).toMatchObject({
      attachments: [{ ...image, data: "aGVsbG8=" }],
    });
  });

  it("constrains agentUrl and carries only owner-resolved initialization", () => {
    const response = { status: "success" as const, data: thread };
    const encoded = Schema.encodeUnknownSync(CreateThreadResponseSchema)(
      Schema.decodeUnknownSync(CreateThreadResponseSchema)(response),
    );
    expect(encoded).toEqual(response);
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadResponseSchema)({
        status: "success",
        data: { ...thread, agentUrl: "https://caller.example/agent" },
      }),
    ).toThrow();
    for (const field of [
      "ownerUserId",
      "conversationId",
      "sandboxId",
      "credentialReference",
      "secret",
    ])
      expect(JSON.stringify(encoded)).not.toContain(field);
    expect(encoded.data.agentInitialization).toEqual(
      thread.agentInitialization,
    );
  });

  it("carries only the initial submission identifier needed for reconciliation", () => {
    const response = {
      status: "success" as const,
      data: thread,
      initialSubmission: { submissionId: "submission-initial" },
    };
    const encoded = Schema.encodeUnknownSync(CreateThreadResponseSchema)(
      Schema.decodeUnknownSync(CreateThreadResponseSchema)(response),
    );

    expect(encoded).toEqual(response);
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadResponseSchema)({
        ...response,
        initialSubmission: { submissionId: "" },
      }),
    ).toThrow();
    expect(JSON.stringify(encoded)).not.toContain("streamUrl");
    expect(JSON.stringify(encoded)).not.toContain("uid");
  });

  it.each([
    [
      CreateThreadInvalidRequestResponseSchema,
      "INVALID_REQUEST",
      "Request validation failed.",
    ],
    [
      CreateThreadProjectNotFoundResponseSchema,
      "PROJECT_NOT_FOUND",
      "Project not found.",
    ],
    [
      CreateThreadProjectlessForbiddenResponseSchema,
      "PROJECT_CREATION_FORBIDDEN",
      "Workspace policy does not allow this project.",
    ],
    [
      CreateThreadRunnerUnavailableResponseSchema,
      "RUNNER_PROFILE_UNAVAILABLE",
      "The selected runner profile is unavailable.",
    ],
    [
      CreateThreadPersistenceUnavailableResponseSchema,
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
