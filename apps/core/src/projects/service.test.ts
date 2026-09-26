import {
  Principal,
  type Project,
  ProjectNameInput,
  ProjectNotFound,
  ProjectRepository,
  RunnerProfileId,
  UserId,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectService } from "./service.js";

const principal = Schema.decodeUnknownSync(Principal)({
  userId: Schema.decodeUnknownSync(UserId)("project-service-owner"),
});
const snapshot = {
  configuration: {
    shipAction: "ship",
    commitAuthor: {
      preference: "dx",
      name: "dx",
      email: "noreply@dx.local",
    },
    signingPreference: "disabled",
    runnerProfileId: Schema.decodeUnknownSync(RunnerProfileId)("e2b-default"),
    publicCodeEnabled: false,
  },
} as const;

describe("ProjectService", () => {
  it("uses the domain factory once and inserts exactly the returned entity", async () => {
    const inserted: Array<Project> = [];
    const repository = ProjectRepository.of({
      ensureProjectless: () => Effect.die("unused"),
      insert: (project) =>
        Effect.sync(() => inserted.push(project)).pipe(Effect.asVoid),
      findOwnedById: (projectId) =>
        Effect.fail(new ProjectNotFound({ projectId })),
      listOwned: () => Effect.succeed({ items: [] }),
      updateOwned: (projectId) =>
        Effect.fail(new ProjectNotFound({ projectId })),
      rebindRepositoryOwned: (projectId) =>
        Effect.fail(new ProjectNotFound({ projectId })),
    });
    const name = Schema.decodeUnknownSync(ProjectNameInput)("project-service");

    const project = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        return yield* service.create(principal, name, snapshot);
      }).pipe(
        Effect.provide(
          ProjectService.layer.pipe(
            Layer.provide(Layer.succeed(ProjectRepository, repository)),
          ),
        ),
      ),
    );

    expect(inserted).toEqual([project]);
    expect(project).toMatchObject({
      ownerUserId: principal.userId,
      name: "project-service",
    });
  });

  it("forwards Principal ownership and pagination to repository operations", async () => {
    const calls: Array<unknown> = [];
    const repository = ProjectRepository.of({
      ensureProjectless: () => Effect.die("unused"),
      insert: () => Effect.void,
      findOwnedById: (projectId, ownerUserId) => {
        calls.push(["get", projectId, ownerUserId]);
        return Effect.fail(new ProjectNotFound({ projectId }));
      },
      listOwned: (ownerUserId, request) => {
        calls.push(["list", ownerUserId, request]);
        return Effect.succeed({ items: [] });
      },
      updateOwned: (projectId) =>
        Effect.fail(new ProjectNotFound({ projectId })),
      rebindRepositoryOwned: (projectId) =>
        Effect.fail(new ProjectNotFound({ projectId })),
    });
    const layer = ProjectService.layer.pipe(
      Layer.provide(Layer.succeed(ProjectRepository, repository)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ProjectService;
        yield* service.list(principal, { limit: 7 });
      }).pipe(Effect.provide(layer)),
    );

    expect(calls).toEqual([["list", principal.userId, { limit: 7 }]]);
  });
});
