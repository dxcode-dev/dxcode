import {
  createThread,
  defaultThreadModelSelection,
  type InvalidPageCursor,
  type Page,
  PersistenceUnavailable,
  PersonalAgentInstructionsRepository,
  type Principal,
  type Project,
  type ProjectId,
  type ProjectNotFound,
  ProjectRepository,
  projectReaderOf,
  type RunnerProfileId,
  type SettingsMembershipInvariantViolation,
  type Thread,
  type ThreadExecutionPin,
  type ThreadId,
  type ThreadListRequest,
  type ThreadModelSelection,
  type ThreadNotFound,
  ThreadRepository,
  type ThreadSourceAdmission,
  ThreadSourceAuthority,
  ThreadSourceIntent,
  ThreadSourceSnapshot,
  type ThreadTitle,
  type ThreadUpdate,
  type WorkspacePolicyDenied,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { PluginService } from "../settings/plugins/service.js";
import type { ProjectCreationSnapshot } from "../settings/project-defaults/service.js";
import { SkillService } from "../settings/skills/service.js";

type ThreadSourceDraft =
  | {
      readonly kind: "finalized";
      readonly snapshot: Omit<ThreadSourceSnapshot, "threadId" | "capturedAt">;
      readonly authority: Omit<ThreadSourceAuthority, "threadId">;
    }
  | {
      readonly kind: "pending";
      readonly intent: Omit<ThreadSourceIntent, "threadId" | "createdAt">;
    };

type ThreadProjectSelection =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | {
      readonly kind: "projectless";
      readonly snapshot: ProjectCreationSnapshot;
    };

/** A Thread checked and snapshotted for creation, not yet persisted. */
export interface PreparedThread {
  readonly thread: Thread;
  /** The Project's row; absent for a Thread created with No Project. */
  readonly project?: Project;
}

interface ThreadServiceShape {
  /**
   * Reads and checks everything a new Thread snapshots, without writing it
   * (a No Project Thread ensures its scope's Project).
   */
  readonly prepare: (
    principal: Principal,
    project: ThreadProjectSelection,
    title: ThreadTitle,
    selection?: ThreadModelSelection,
    threadId?: ThreadId,
    runnerProfileId?: RunnerProfileId,
    titlePending?: boolean,
    parentThreadId?: ThreadId,
  ) => Effect.Effect<
    PreparedThread,
    | Schema.SchemaError
    | PersistenceUnavailable
    | ProjectNotFound
    | ThreadNotFound
    | SettingsMembershipInvariantViolation
    | WorkspacePolicyDenied
  >;
  readonly insert: (
    thread: Thread,
    source?: ThreadSourceDraft,
    executionPin?: ThreadExecutionPin,
  ) => Effect.Effect<Thread, Schema.SchemaError | PersistenceUnavailable>;
  readonly get: (
    principal: Principal,
    threadId: ThreadId,
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  readonly list: (
    principal: Principal,
    projectId: ProjectId | undefined,
    request: ThreadListRequest,
  ) => Effect.Effect<
    Page<Thread>,
    Schema.SchemaError | PersistenceUnavailable | InvalidPageCursor
  >;
  /** The child Threads listed under these roots; see the repository. */
  readonly listChildren: (
    principal: Principal,
    parentThreadIds: ReadonlyArray<ThreadId>,
    lifecycleState: "active" | "archived",
    perParent: number,
  ) => Effect.Effect<
    ReadonlyArray<Thread>,
    Schema.SchemaError | PersistenceUnavailable
  >;
  readonly setPinned: (
    principal: Principal,
    threadId: ThreadId,
    pinned: boolean,
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  /** Snoozes the Thread until `snoozedUntil`, or wakes it when undefined. */
  readonly setSnoozed: (
    principal: Principal,
    threadId: ThreadId,
    snoozedUntil: Thread["snoozedUntil"],
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  readonly update: (
    principal: Principal,
    threadId: ThreadId,
    update: ThreadUpdate,
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
  readonly setArchived: (
    principal: Principal,
    threadId: ThreadId,
    archived: boolean,
  ) => Effect.Effect<
    Thread,
    Schema.SchemaError | PersistenceUnavailable | ThreadNotFound
  >;
}

export class ThreadService extends Context.Service<
  ThreadService,
  ThreadServiceShape
>()("@dx/core/threads/ThreadService") {
  static readonly layer = Layer.effect(
    ThreadService,
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      const threads = yield* ThreadRepository;
      const instructions = yield* PersonalAgentInstructionsRepository;
      const pluginService = yield* PluginService;
      const skillService = yield* SkillService;

      return ThreadService.of({
        prepare: Effect.fn("ThreadService.prepare")(
          function* (
            principal,
            project,
            title,
            selection,
            threadId,
            runnerProfileId,
            titlePending,
            parentThreadId,
          ) {
            // A family has one root: a child's child keeps the root as its
            // parent and records the child as the Thread that started it.
            const parent =
              parentThreadId === undefined
                ? Effect.succeed(undefined)
                : threads.findOwnedById(
                    parentThreadId,
                    projectReaderOf(principal),
                  );
            const currentInstructions = instructions
              .findOwnedByUser(principal.userId)
              .pipe(
                Effect.catchTag("PersonalAgentInstructionsNotFound", (cause) =>
                  Effect.fail(
                    PersistenceUnavailable.new(
                      { operation: "thread.resolveAgentInstructions" },
                      cause,
                    ),
                  ),
                ),
              );
            const projectId =
              project.kind === "project"
                ? project.projectId
                : yield* projects.ensureProjectless(
                    principal.userId,
                    project.snapshot,
                  );
            // Every read below is independent once the Project is known.
            const [
              parentThread,
              ownedProject,
              agentInstructions,
              plugins,
              skills,
            ] = yield* Effect.all(
              [
                parent,
                project.kind === "project"
                  ? projects.findOwnedById(
                      projectId,
                      projectReaderOf(principal),
                    )
                  : Effect.succeed(undefined),
                currentInstructions,
                pluginService.resolveForThread(principal, projectId),
                skillService.resolveForThread(principal, projectId),
              ],
              { concurrency: "unbounded" },
            );
            const thread = yield* createThread({
              ...(threadId === undefined ? {} : { id: threadId }),
              title,
              projectId,
              ownerUserId: principal.userId,
              agentInstructions: {
                content: agentInstructions.content,
                revision: agentInstructions.revision,
                version: agentInstructions.version,
              },
              selection: selection ?? defaultThreadModelSelection(),
              ...(runnerProfileId === undefined ? {} : { runnerProfileId }),
              ...(titlePending === true ? { titlePending } : {}),
              ...(parentThread === undefined
                ? {}
                : {
                    parentThreadId:
                      parentThread.parentThreadId ?? parentThread.id,
                    startedByThreadId: parentThread.id,
                    // The insert copies the family's sharing too.
                    ...(parentThread.visibility === undefined
                      ? {}
                      : { visibility: parentThread.visibility }),
                  }),
              plugins,
              skills,
            });
            return {
              thread,
              ...(ownedProject === undefined ? {} : { project: ownedProject }),
            };
          },
        ),
        insert: Effect.fn("ThreadService.insert")(
          function* (thread, source, executionPin) {
            let admission: ThreadSourceAdmission | undefined;
            if (source?.kind === "pending") {
              admission = {
                kind: "pending",
                intent: yield* Schema.decodeUnknownEffect(
                  Schema.toType(ThreadSourceIntent),
                )({
                  ...source.intent,
                  threadId: thread.id,
                  createdAt: thread.createdAt,
                }),
              };
            } else if (source?.kind === "finalized") {
              admission = {
                kind: "finalized",
                snapshot: yield* Schema.decodeUnknownEffect(
                  Schema.toType(ThreadSourceSnapshot),
                )({
                  ...source.snapshot,
                  threadId: thread.id,
                  capturedAt: thread.createdAt,
                }),
                authority: yield* Schema.decodeUnknownEffect(
                  Schema.toType(ThreadSourceAuthority),
                )({ ...source.authority, threadId: thread.id }),
              };
            }
            yield* threads.insert(thread, admission, executionPin);
            return thread;
          },
        ),
        get: Effect.fn("ThreadService.get")((principal, threadId) =>
          threads.findOwnedById(threadId, projectReaderOf(principal)),
        ),
        list: Effect.fn("ThreadService.list")((principal, projectId, request) =>
          threads.listOwned(projectReaderOf(principal), projectId, request),
        ),
        listChildren: Effect.fn("ThreadService.listChildren")(
          (principal, parentThreadIds, lifecycleState, perParent) =>
            threads.listChildrenOwned(
              projectReaderOf(principal),
              parentThreadIds,
              lifecycleState,
              perParent,
            ),
        ),
        setPinned: Effect.fn("ThreadService.setPinned")(
          function* (principal, threadId, pinned) {
            const pinnedAt = pinned ? yield* DateTime.now : undefined;
            return yield* threads.setPinnedAtOwned(
              threadId,
              principal.userId,
              pinnedAt,
            );
          },
        ),
        setSnoozed: Effect.fn("ThreadService.setSnoozed")(
          (principal, threadId, snoozedUntil) =>
            threads.setSnoozedUntilOwned(
              threadId,
              principal.userId,
              snoozedUntil,
            ),
        ),
        update: Effect.fn("ThreadService.update")(
          (principal, threadId, update) =>
            threads.updateOwned(threadId, principal.userId, update),
        ),
        setArchived: Effect.fn("ThreadService.setArchived")(
          (principal, threadId, archived) =>
            threads.setLifecycleStateOwned(
              threadId,
              principal.userId,
              archived ? "archived" : "active",
            ),
        ),
      });
    }),
  );
}
