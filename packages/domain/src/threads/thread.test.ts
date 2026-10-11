import { DateTime, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectId } from "../projects/project-id.js";
import { defaultThreadModelSelection } from "../settings/model-routing.js";
import { PersonalAgentInstructionsSnapshot } from "../settings/personal-agent-instructions.js";
import { UserId } from "../users/user-id.js";
import { createThread, isThreadTitlePending } from "./thread.js";

const ownerUserId = Schema.decodeUnknownSync(UserId)("user-1");
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000001",
);
const agentInstructions = Schema.decodeUnknownSync(
  PersonalAgentInstructionsSnapshot,
)({ content: "Use focused tests.", revision: 2, version: 1 });
const selection = defaultThreadModelSelection();

describe("Thread domain", () => {
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
});
