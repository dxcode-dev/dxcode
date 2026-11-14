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
import { THREAD_TITLE_PENDING_MS, ThreadTitle } from "./thread-title.js";

export const ThreadVisibility = Schema.Literals(["private", "workspace"]);

export type ThreadVisibility = typeof ThreadVisibility.Type;

export const ThreadActivityStatus = Schema.Literals(["idle", "working"]);

export type ThreadActivityStatus = typeof ThreadActivityStatus.Type;

export const ThreadLifecycleState = Schema.Literals(["active", "archived"]);

export type ThreadLifecycleState = typeof ThreadLifecycleState.Type;

/** Colors an owner may give a Thread; absent means auto. */
export const THREAD_COLORS = [
  "gray",
  "blue",
  "purple",
  "pink",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
] as const;

export const ThreadColor = Schema.Literals(THREAD_COLORS);

export type ThreadColor = typeof ThreadColor.Type;

/**
 * A plain Thread, or a Space: a root Thread whose agent coordinates work for
 * a goal and starts one child Thread per piece of it.
 */
export const ThreadKind = Schema.Literals(["thread", "space"]);

export type ThreadKind = typeof ThreadKind.Type;

/**
 * Where a Thread's agent runs. `orb`: in or beside the Thread's Orb, as every
 * Thread did before. `executor`: no Orb; the dx agent runs in its Durable
 * Object only, and Claude Code in the Thread's executor container. The
 * server sets it at creation and it never changes; it is independent of the
 * Thread's kind (wiki/runtime-architecture.md#execution-modes).
 */
export const ThreadExecutionMode = Schema.Literals(["orb", "executor"]);

export type ThreadExecutionMode = typeof ThreadExecutionMode.Type;

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
  /** The owner snoozed the Thread until this time; see `threadSnoozeState`. */
  snoozedUntil: Schema.optional(Timestamp),
  snoozedAt: Schema.optional(Timestamp),
  /** When a snooze last ended, by its timer or the owner. */
  snoozeWokeAt: Schema.optional(Timestamp),
  color: Schema.optional(ThreadColor),
  /**
   * The plugin Thread type, `<plugin name>/<type id>`, whose view draws
   * the Thread's main area. Set only when the Thread is created.
   */
  pluginThreadType: Schema.optional(
    Schema.String.check(Schema.isMaxLength(130)),
  ),
  /** Until this time clients show a loading title while one is generated. */
  titlePendingUntil: Schema.optional(Timestamp),
  /**
   * The root of the Thread's family; never itself a child. Sharing, archive,
   * and delete act on the family through it.
   */
  parentThreadId: Schema.optional(ThreadId),
  /**
   * The family member whose agent started this Thread: the root or any of
   * its children. Absent for a root, and for a child started before dx
   * recorded it or whose starter was deleted; that child sits under the root.
   */
  startedByThreadId: Schema.optional(ThreadId),
  /** Absent means `thread`. */
  kind: Schema.optional(ThreadKind),
  /** Absent means `orb`. */
  executionMode: Schema.optional(ThreadExecutionMode),
  /** The person whose message made a Space's agent start this Thread. */
  requestedByUserId: Schema.optional(UserId),
});

export type Thread = typeof Thread.Type;

/** Whether clients should still show the title as loading. */
export const isThreadTitlePending = (thread: Thread, now = Date.now()) =>
  thread.titlePendingUntil !== undefined &&
  DateTime.toEpochMillis(thread.titlePendingUntil) > now;

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
  titlePending: Schema.optional(Schema.Boolean),
  parentThreadId: Schema.optional(ThreadId),
  startedByThreadId: Schema.optional(ThreadId),
  kind: Schema.optional(ThreadKind),
  executionMode: Schema.optional(ThreadExecutionMode),
  requestedByUserId: Schema.optional(UserId),
  /** The plugin Thread type, `<plugin>/<type>`. */
  pluginThreadType: Schema.optional(Schema.String),
});

export type CreateThreadInput = typeof CreateThreadInput.Type;

export const createThread = Effect.fn("createThread")(function* (
  input: CreateThreadInput,
) {
  const now = yield* DateTime.now;
  const { id = newThreadId(), titlePending, ...threadInput } = input;

  return yield* Schema.decodeUnknownEffect(Schema.toType(Thread))({
    id,
    ...threadInput,
    ...(titlePending === true
      ? {
          titlePendingUntil: DateTime.add(now, {
            milliseconds: THREAD_TITLE_PENDING_MS,
          }),
        }
      : {}),
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    activityStatus: "idle",
    lifecycleState: "active",
  });
});
