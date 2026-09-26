import {
  createThread,
  defaultThreadModelSelection,
  type InvalidPageCursor,
  type Page,
  PersistenceUnavailable,
  PersonalAgentInstructionsRepository,
  type Principal,
  type ProjectId,
  type ProjectNotFound,
  ProjectRepository,
  type RunnerProfileId,
  type SettingsMembershipInvariantViolation,
  type Thread,
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

interface ThreadServiceShape {
  readonly create: (
    principal: Principal,
    project: ThreadProjectSelection,
    title: ThreadTitle,
    selection?: ThreadModelSelection,
    source?: ThreadSourceDraft,
    threadId?: ThreadId,
    runnerProfileId?: RunnerProfileId,
  ) => Effect.Effect<
    Thread,
    | Schema.SchemaError
    | PersistenceUnavailable
    | ProjectNotFound
    | SettingsMembershipInvariantViolation
    | WorkspacePolicyDenied
  >;
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
  readonly setPinned: (
    principal: Principal,
    threadId: ThreadId,
    pinned: boolean,
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
      const plugins = yield* PluginService;
      const skills = yield* SkillService;

      return ThreadService.of({
        create: Effect.fn("ThreadService.create")(
          function* (
            principal,
            project,
            title,
            selection,
            source,
            threadId,
            runnerProfileId,
          ) {
            const projectId =
              project.kind === "project"
                ? project.projectId
                : yield* projects.ensureProjectless(
                    principal.userId,
                    project.snapshot,
                  );
            if (project.kind === "project")
              yield* projects.findOwnedById(projectId, principal.userId);
            const currentInstructions = yield* instructions
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
            const thread = yield* createThread({
              ...(threadId === undefined ? {} : { id: threadId }),
              title,
              projectId,
              ownerUserId: principal.userId,
              agentInstructions: {
                content: currentInstructions.content,
                revision: currentInstructions.revision,
                version: currentInstructions.version,
              },
              selection: selection ?? defaultThreadModelSelection(),
              ...(runnerProfileId === undefined ? {} : { runnerProfileId }),
              plugins: yield* plugins.resolveForThread(principal, projectId),
              skills: yield* skills.resolveForThread(principal, projectId),
            });
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
            yield* threads.insert(thread, admission);
            return thread;
          },
        ),
        get: Effect.fn("ThreadService.get")((principal, threadId) =>
          threads.findOwnedById(threadId, principal.userId),
        ),
        list: Effect.fn("ThreadService.list")((principal, projectId, request) =>
          threads.listOwned(principal.userId, projectId, request),
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
