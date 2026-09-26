import { DateTime, Effect, Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { ProjectId } from "../projects/project-id.js";
import { ThreadModelSelection } from "../settings/model-routing.js";
import { PersonalAgentInstructionsSnapshot } from "../settings/personal-agent-instructions.js";
import { ResolvedPluginSnapshots } from "../settings/plugin.js";
import { RunnerProfileId } from "../settings/runner-profile.js";
import { ResolvedSkillSnapshots } from "../settings/skill.js";
import { UserId } from "../users/user-id.js";
import { newThreadId, ThreadId } from "./thread-id.js";
import { ThreadTitle } from "./thread-title.js";

export const ThreadVisibility = Schema.Literals(["private", "workspace"]);

export type ThreadVisibility = typeof ThreadVisibility.Type;

export const ThreadActivityStatus = Schema.Literals(["idle", "working"]);

export type ThreadActivityStatus = typeof ThreadActivityStatus.Type;

export const ThreadLifecycleState = Schema.Literals(["active", "archived"]);

export type ThreadLifecycleState = typeof ThreadLifecycleState.Type;

export const Thread = Schema.Struct({
  id: ThreadId,
  title: ThreadTitle,
  projectId: ProjectId,
  ownerUserId: UserId,
  agentInstructions: PersonalAgentInstructionsSnapshot,
  selection: ThreadModelSelection,
  runnerProfileId: Schema.optional(RunnerProfileId),
  plugins: ResolvedPluginSnapshots,
  skills: ResolvedSkillSnapshots,
  visibility: Schema.optional(ThreadVisibility),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastActivityAt: Timestamp,
  activityStatus: ThreadActivityStatus,
  lifecycleState: ThreadLifecycleState,
  pinnedAt: Schema.optional(Timestamp),
});

export type Thread = typeof Thread.Type;

export const CreateThreadInput = Schema.Struct({
  id: Schema.optional(ThreadId),
  title: ThreadTitle,
  projectId: ProjectId,
  ownerUserId: UserId,
  agentInstructions: PersonalAgentInstructionsSnapshot,
  selection: ThreadModelSelection,
  runnerProfileId: Schema.optional(RunnerProfileId),
  plugins: ResolvedPluginSnapshots,
  skills: ResolvedSkillSnapshots,
  visibility: Schema.optional(ThreadVisibility),
});

export type CreateThreadInput = typeof CreateThreadInput.Type;

export const createThread = Effect.fn("createThread")(function* (
  input: CreateThreadInput,
) {
  const now = yield* DateTime.now;
  const { id = newThreadId(), ...threadInput } = input;

  return yield* Schema.decodeUnknownEffect(Schema.toType(Thread))({
    id,
    ...threadInput,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    activityStatus: "idle",
    lifecycleState: "active",
  });
});
