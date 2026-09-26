import {
  defaultThreadModelSelection,
  PersonalAgentInstructions,
  PersonalAgentInstructionsRepository,
  Principal,
  Project,
  ProjectId,
  ProjectNotFound,
  ProjectRepository,
  ResolvedSkillSnapshot,
  type Thread,
  ThreadNotFound,
  ThreadRepository,
  type ThreadSourceAdmission,
  UserId,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PluginService } from "../settings/plugins/service.js";
import { SkillService } from "../settings/skills/service.js";
import { ThreadService } from "./service.js";

const ownerUserId = Schema.decodeUnknownSync(UserId)("thread-service-owner");
const principal = Schema.decodeUnknownSync(Principal)({ userId: ownerUserId });
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000081",
);
const project = Schema.decodeUnknownSync(Project)({
  id: projectId,
  ownerUserId,
  name: "Threads",
  configuration: {
    shipAction: "ship",
    commitAuthor: {
      preference: "dx",
      name: "dx",
      email: "noreply@dx.local",
    },
    signingPreference: "disabled",
    runnerProfileId: "e2b-default",
    publicCodeEnabled: false,
  },
  revision: 0,
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z",
});
const personalAgentInstructions = Schema.decodeUnknownSync(
  PersonalAgentInstructions,
)({
  userId: ownerUserId,
  content: "Keep changes focused.",
  revision: 3,
  version: 1,
  updatedAt: "2026-08-20T12:00:00.000Z",
});
const instructions = PersonalAgentInstructionsRepository.of({
  findOwnedByUser: () => Effect.succeed(personalAgentInstructions),
  updateOwnedByUser: () => Effect.succeed(personalAgentInstructions),
});
const defaultSelection = defaultThreadModelSelection();
const noSkills = Layer.succeed(
  SkillService,
  SkillService.of({
    resolveForThread: () => Effect.succeed([]),
  } as unknown as SkillService["Service"]),
);
const noPlugins = Layer.succeed(
  PluginService,
  PluginService.of({
    resolveForThread: () => Effect.succeed([]),
  } as unknown as PluginService["Service"]),
);
const noExtensions = Layer.merge(noSkills, noPlugins);

describe("ThreadService", () => {
  it("checks the owned Project before creating and inserts the returned Thread", async () => {
    const calls: Array<string> = [];
    const inserted: Array<Thread> = [];
    let projectlessConfiguration: Project["configuration"] | undefined;
    const projects = ProjectRepository.of({
      ensureProjectless: (_ownerUserId, snapshot) =>
        Effect.sync(() => {
          calls.push("project:ensure-projectless");
          projectlessConfiguration = snapshot.configuration;
          return projectId;
        }),
      insert: () => Effect.void,
      findOwnedById: (_projectId, requestedOwner) =>
        Effect.sync(() => {
          calls.push(`project:${requestedOwner}`);
          return project;
        }),
      listOwned: () => Effect.succeed({ items: [] }),
      updateOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
      rebindRepositoryOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
    });
    const threads = ThreadRepository.of({
      insert: (thread) =>
        Effect.sync(() => {
          calls.push("thread:insert");
          inserted.push(thread);
        }),
      findOwnedById: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setPinnedAtOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setLifecycleStateOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      listOwned: () => Effect.succeed({ items: [] }),
    });
    const repositories = Layer.mergeAll(
      Layer.succeed(PersonalAgentInstructionsRepository, instructions),
      Layer.succeed(ProjectRepository, projects),
      Layer.succeed(ThreadRepository, threads),
      noExtensions,
    );

    const thread = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.create(
          principal,
          { kind: "project", projectId },
          "Test thread",
          {
            kind: "mode" as const,
            profileId: "default" as const,
            mode: "medium" as const,
          },
        );
      }).pipe(
        Effect.provide(ThreadService.layer.pipe(Layer.provide(repositories))),
      ),
    );

    expect(calls).toEqual([`project:${ownerUserId}`, "thread:insert"]);
    expect(inserted).toEqual([thread]);
    expect(thread).toMatchObject({
      projectId,
      ownerUserId,
      agentInstructions: {
        content: "Keep changes focused.",
        revision: 3,
        version: 1,
      },
      selection: defaultSelection,
    });

    const projectlessThread = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.create(
          principal,
          {
            kind: "projectless",
            snapshot: { configuration: project.configuration },
          },
          "Projectless thread",
          defaultSelection,
        );
      }).pipe(
        Effect.provide(ThreadService.layer.pipe(Layer.provide(repositories))),
      ),
    );
    expect(projectlessThread.projectId).toBe(projectId);
    expect(calls).toContain("project:ensure-projectless");
    expect(projectlessConfiguration).toEqual(project.configuration);
  });

  it("creates a typed source snapshot from an authorized repository", async () => {
    let insertedThread: Thread | undefined;
    let insertedSource: ThreadSourceAdmission | undefined;
    const projects = ProjectRepository.of({
      ensureProjectless: () => Effect.succeed(projectId),
      insert: () => Effect.void,
      findOwnedById: () => Effect.succeed(project),
      listOwned: () => Effect.succeed({ items: [] }),
      updateOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
      rebindRepositoryOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
    });
    const threads = ThreadRepository.of({
      insert: (thread, source) =>
        Effect.sync(() => {
          insertedThread = thread;
          insertedSource = source;
        }),
      findOwnedById: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setPinnedAtOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setLifecycleStateOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      listOwned: () => Effect.succeed({ items: [] }),
    });
    const repositories = Layer.mergeAll(
      Layer.succeed(PersonalAgentInstructionsRepository, instructions),
      Layer.succeed(ProjectRepository, projects),
      Layer.succeed(ThreadRepository, threads),
      noExtensions,
    );

    const thread = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.create(
          principal,
          { kind: "project", projectId },
          "Source thread",
          defaultSelection,
          {
            kind: "finalized",
            snapshot: {
              version: 2,
              projectId,
              bindingRevision: 1,
              provider: "github",
              repositoryName: "owner/repository",
              cloneUrl: "https://github.com/owner/repository.git",
              defaultBranch: "main",
              sourceRevision: "a".repeat(40),
              initialRef: "refs/heads/main",
            },
            authority: {
              grantId: "grant-81" as never,
              installationId: "9081",
              providerRepositoryId: "7081",
              authorizationEpoch: 1,
              installationEpoch: 1,
              policyRevision: 0,
              privateSubmoduleRepositoryIds: [],
            },
          },
        );
      }).pipe(
        Effect.provide(ThreadService.layer.pipe(Layer.provide(repositories))),
      ),
    );

    expect(insertedThread).toEqual(thread);
    expect(insertedSource).toMatchObject({
      kind: "finalized",
      snapshot: {
        threadId: thread.id,
        capturedAt: thread.createdAt,
        repositoryName: "owner/repository",
        sourceRevision: "a".repeat(40),
      },
      authority: {
        threadId: thread.id,
        providerRepositoryId: "7081",
      },
    });
  });

  it("does not create or insert a Thread when the owned Project is absent", async () => {
    let insertCount = 0;
    const projects = ProjectRepository.of({
      ensureProjectless: () => Effect.succeed(projectId),
      insert: () => Effect.void,
      findOwnedById: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
      listOwned: () => Effect.succeed({ items: [] }),
      updateOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
      rebindRepositoryOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
    });
    const threads = ThreadRepository.of({
      insert: () => Effect.sync(() => insertCount++).pipe(Effect.asVoid),
      findOwnedById: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setPinnedAtOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setLifecycleStateOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      listOwned: () => Effect.succeed({ items: [] }),
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* service.create(
          principal,
          { kind: "project", projectId },
          "Test thread",
          {
            kind: "mode" as const,
            profileId: "default" as const,
            mode: "medium" as const,
          },
        );
      }).pipe(
        Effect.provide(
          ThreadService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  PersonalAgentInstructionsRepository,
                  instructions,
                ),
                Layer.succeed(ProjectRepository, projects),
                Layer.succeed(ThreadRepository, threads),
                noExtensions,
              ),
            ),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(ProjectNotFound);
    expect(insertCount).toBe(0);
  });

  it("concurrent creates produce unique factory-owned ThreadIds", async () => {
    const inserted: Array<Thread> = [];
    const projects = ProjectRepository.of({
      ensureProjectless: () => Effect.succeed(projectId),
      insert: () => Effect.void,
      findOwnedById: () => Effect.succeed(project),
      listOwned: () => Effect.succeed({ items: [] }),
      updateOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
      rebindRepositoryOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
    });
    const threads = ThreadRepository.of({
      insert: (thread) =>
        Effect.sync(() => inserted.push(thread)).pipe(Effect.asVoid),
      findOwnedById: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setPinnedAtOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setLifecycleStateOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      listOwned: () => Effect.succeed({ items: [] }),
    });
    const layer = ThreadService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(PersonalAgentInstructionsRepository, instructions),
          Layer.succeed(ProjectRepository, projects),
          Layer.succeed(ThreadRepository, threads),
          noExtensions,
        ),
      ),
    );

    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ThreadService;
        return yield* Effect.all(
          Array.from({ length: 20 }, () =>
            service.create(
              principal,
              { kind: "project", projectId },
              "Test thread",
              {
                kind: "mode" as const,
                profileId: "default" as const,
                mode: "medium" as const,
              },
            ),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(new Set(created.map(({ id }) => id)).size).toBe(20);
    expect(inserted).toHaveLength(20);
  });

  it("snapshots current settings for new Threads without changing existing Threads", async () => {
    let resolved = personalAgentInstructions;
    let resolvedSkills = [
      Schema.decodeUnknownSync(ResolvedSkillSnapshot)({
        id: "skl_00000000-0000-4000-8000-000000000044",
        version: 1,
        name: "review-guidelines",
        scope: "personal",
        integrity: "a".repeat(64),
      }),
    ];
    const inserted: Array<Thread> = [];
    const projects = ProjectRepository.of({
      ensureProjectless: () => Effect.succeed(projectId),
      insert: () => Effect.void,
      findOwnedById: () => Effect.succeed(project),
      listOwned: () => Effect.succeed({ items: [] }),
      updateOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
      rebindRepositoryOwned: (requestedProjectId) =>
        Effect.fail(new ProjectNotFound({ projectId: requestedProjectId })),
    });
    const threads = ThreadRepository.of({
      insert: (thread) =>
        Effect.sync(() => inserted.push(thread)).pipe(Effect.asVoid),
      findOwnedById: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setPinnedAtOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      setLifecycleStateOwned: (threadId) =>
        Effect.fail(new ThreadNotFound({ threadId })),
      listOwned: () => Effect.succeed({ items: [] }),
    });
    const currentInstructions = PersonalAgentInstructionsRepository.of({
      findOwnedByUser: () => Effect.succeed(resolved),
      updateOwnedByUser: () => Effect.succeed(resolved),
    });
    const currentSkills = Layer.succeed(
      SkillService,
      SkillService.of({
        resolveForThread: () => Effect.succeed(resolvedSkills),
      } as unknown as SkillService["Service"]),
    );
    const layer = ThreadService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          currentSkills,
          noPlugins,
          Layer.succeed(
            PersonalAgentInstructionsRepository,
            currentInstructions,
          ),
          Layer.succeed(ProjectRepository, projects),
          Layer.succeed(ThreadRepository, threads),
        ),
      ),
    );

    const [existing, createdAfterChange] = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ThreadService;
        const first = yield* service.create(
          principal,
          { kind: "project", projectId },
          "Test thread",
          {
            kind: "mode" as const,
            profileId: "default" as const,
            mode: "medium" as const,
          },
        );
        resolved = Schema.decodeUnknownSync(PersonalAgentInstructions)({
          userId: ownerUserId,
          content: "Use the new preference.",
          revision: 4,
          version: 1,
          updatedAt: "2026-08-20T12:00:00.000Z",
        });
        resolvedSkills = [
          Schema.decodeUnknownSync(ResolvedSkillSnapshot)({
            id: "skl_00000000-0000-4000-8000-000000000044",
            version: 2,
            name: "review-guidelines",
            scope: "personal",
            integrity: "b".repeat(64),
          }),
        ];
        return [
          first,
          yield* service.create(
            principal,
            { kind: "project", projectId },
            "Test thread",
            {
              kind: "mode" as const,
              profileId: "default" as const,
              mode: "medium" as const,
            },
          ),
        ] as const;
      }).pipe(Effect.provide(layer)),
    );

    expect(existing.agentInstructions).toMatchObject({
      content: "Keep changes focused.",
      revision: 3,
    });
    expect(createdAfterChange.agentInstructions).toMatchObject({
      content: "Use the new preference.",
      revision: 4,
    });
    expect(existing.selection).toEqual(defaultSelection);
    expect(createdAfterChange.selection).toEqual(defaultSelection);
    expect(existing.skills).toEqual([
      expect.objectContaining({ version: 1, integrity: "a".repeat(64) }),
    ]);
    expect(createdAfterChange.skills).toEqual([
      expect.objectContaining({ version: 2, integrity: "b".repeat(64) }),
    ]);
    expect(inserted[0]?.skills).toEqual(existing.skills);
    expect(inserted[0]?.agentInstructions).toEqual(existing.agentInstructions);
    expect(inserted[0]?.selection).toEqual(existing.selection);
  });
});
