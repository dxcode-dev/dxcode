import { DateTime, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectId } from "../projects/project-id.js";
import {
  defaultThreadModelSelection,
  ThreadModelSelection,
} from "../settings/model-routing.js";
import { PersonalAgentInstructionsSnapshot } from "../settings/personal-agent-instructions.js";
import { UserId } from "../users/user-id.js";
import { createThread, isThreadTitlePending, Thread } from "./thread.js";
import { ThreadId } from "./thread-id.js";

const ownerUserId = Schema.decodeUnknownSync(UserId)("user-1");
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000001",
);
const agentInstructions = Schema.decodeUnknownSync(
  PersonalAgentInstructionsSnapshot,
)({ content: "Use focused tests.", revision: 2, version: 1 });
const selection = defaultThreadModelSelection();

describe("Thread domain", () => {
  it("validates IDs and creates unique opaque IDs", async () => {
    expect(() => Schema.decodeUnknownSync(ThreadId)("thread-1")).toThrow();
    const [first, second] = await Effect.runPromise(
      Effect.all([
        createThread({
          title: "Test thread",
          ownerUserId,
          projectId,
          agentInstructions,
          selection,
          plugins: [],
          skills: [],
        }),
        createThread({
          title: "Test thread",
          ownerUserId,
          projectId,
          agentInstructions,
          selection,
          plugins: [],
          skills: [],
        }),
      ]),
    );

    expect(first.id).not.toBe(second.id);
    expect(DateTime.formatIso(first.createdAt)).toBe(
      DateTime.formatIso(first.updatedAt),
    );
  });

  it("marks a generated title as pending only until its deadline", async () => {
    const input = {
      title: "Fix OAuth retries",
      ownerUserId,
      projectId,
      agentInstructions,
      selection,
      plugins: [],
      skills: [],
    };
    const [settled, pending] = await Effect.runPromise(
      Effect.all([
        createThread(input),
        createThread({ ...input, titlePending: true }),
      ]),
    );
    const createdAt = DateTime.toEpochMillis(pending.createdAt);

    expect(settled.titlePendingUntil).toBeUndefined();
    expect(isThreadTitlePending(settled)).toBe(false);
    expect(isThreadTitlePending(pending, createdAt)).toBe(true);
    expect(isThreadTitlePending(pending, createdAt + 40_000)).toBe(false);
  });

  it("encodes the stored model selection without runtime history", async () => {
    const thread = await Effect.runPromise(
      createThread({
        title: "Test thread",
        ownerUserId,
        projectId,
        agentInstructions,
        selection,
        plugins: [],
        skills: [],
      }),
    );
    const encoded = Schema.encodeSync(Thread)(thread);

    expect(encoded).toEqual({
      id: thread.id,
      title: "Test thread",
      projectId,
      ownerUserId,
      agentInstructions: {
        content: "Use focused tests.",
        revision: 2,
        version: 1,
      },
      selection: Schema.encodeSync(ThreadModelSelection)(selection),
      plugins: [],
      skills: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      lastActivityAt: expect.any(String),
      activityStatus: "idle",
      lifecycleState: "active",
    });
    expect(Object.keys(encoded)).not.toEqual(
      expect.arrayContaining([
        "conversationId",
        "sandboxId",
        "credentialReference",
        "credentialId",
        "secret",
      ]),
    );
  });
});
