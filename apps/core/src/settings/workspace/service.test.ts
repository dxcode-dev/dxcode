import {
  CreateWorkspaceInput,
  Principal,
  SettingsScopeForbidden,
  UpdateWorkspaceProfileInput,
  WorkspaceMembership,
  WorkspaceMembershipExists,
  WorkspaceRepository,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit, type SettingsAuditEvent } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspaceProfileService } from "./service.js";

const principal = Schema.decodeUnknownSync(Principal)({
  userId: "workspace-owner",
  credentialScopes: ["personal", "workspace"],
});
const membership = Schema.decodeUnknownSync(WorkspaceMembership)({
  workspace: {
    id: "stable-workspace-id",
    displayName: "DX Team",
    shortName: "dx-team",
    lifecycleState: "active",
    revision: 0,
  },
  userId: principal.userId,
  role: "owner",
});

const layerFor = (
  repository: WorkspaceRepository["Service"],
  events: Array<SettingsAuditEvent>,
) => {
  const repositoryLayer = Layer.succeed(WorkspaceRepository, repository);
  const settingsLayer = SettingsService.layer.pipe(
    Layer.provide(repositoryLayer),
  );
  const auditLayer = Layer.succeed(
    SettingsAudit,
    SettingsAudit.of({
      record: (event) => Effect.sync(() => events.push(event)),
    }),
  );
  return WorkspaceProfileService.layer.pipe(
    Layer.provide(Layer.mergeAll(repositoryLayer, settingsLayer, auditLayer)),
  );
};

describe("WorkspaceProfileService", () => {
  it("creates only when the principal has no membership", async () => {
    const input = Schema.decodeUnknownSync(CreateWorkspaceInput)({
      displayName: "New Team",
      shortName: "new-team",
    });
    const creates: Array<unknown> = [];
    const events: Array<SettingsAuditEvent> = [];
    const repository = WorkspaceRepository.of({
      findByUser: () => Effect.succeed(Option.none()),
      createOwnedByUser: (userId, createInput) => {
        creates.push({ userId, input: createInput });
        return Effect.succeed({
          ...membership,
          workspace: {
            ...membership.workspace,
            displayName: createInput.displayName,
            shortName: createInput.shortName,
          },
        });
      },
      updateProfile: () => Effect.die("not used"),
    });
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkspaceProfileService;
        return yield* service.create(principal, input, "request-create");
      }).pipe(Effect.provide(layerFor(repository, events))),
    );

    expect(creates).toEqual([{ userId: principal.userId, input }]);
    expect(created.workspace.id).toBe("stable-workspace-id");
    expect(events).toMatchObject([
      {
        action: "workspace.create",
        outcome: "success",
        fields: ["displayName", "shortName"],
      },
    ]);

    const existingRepository = WorkspaceRepository.of({
      ...repository,
      findByUser: () => Effect.succeed(Option.some(membership)),
    });
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspaceProfileService;
          return yield* service.create(principal, input, "request-second");
        }).pipe(Effect.provide(layerFor(existingRepository, []))),
      ),
    ).rejects.toBeInstanceOf(WorkspaceMembershipExists);
  });

  it("updates an owner by stable ID and rejects a member mutation", async () => {
    const input = Schema.decodeUnknownSync(UpdateWorkspaceProfileInput)({
      displayName: "Renamed Team",
      shortName: "renamed-team",
    });
    const updates: Array<unknown> = [];
    const repository = WorkspaceRepository.of({
      findByUser: () => Effect.succeed(Option.some(membership)),
      createOwnedByUser: () => Effect.die("not used"),
      updateProfile: (workspaceId, updateInput, expectedRevision) => {
        updates.push({ workspaceId, input: updateInput, expectedRevision });
        return Effect.succeed({ ...membership.workspace, ...updateInput });
      },
    });
    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkspaceProfileService;
        return yield* service.update(
          principal,
          membership.workspace.shortName,
          input,
          0,
          "request-update",
        );
      }).pipe(Effect.provide(layerFor(repository, []))),
    );

    expect(updates).toEqual([
      { workspaceId: membership.workspace.id, input, expectedRevision: 0 },
    ]);
    expect(updated.workspace).toMatchObject({
      id: "stable-workspace-id",
      shortName: "renamed-team",
    });

    const memberRepository = WorkspaceRepository.of({
      ...repository,
      findByUser: () =>
        Effect.succeed(Option.some({ ...membership, role: "member" as const })),
    });
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspaceProfileService;
          return yield* service.update(
            principal,
            membership.workspace.shortName,
            input,
            0,
            "request-member",
          );
        }).pipe(Effect.provide(layerFor(memberRepository, []))),
      ),
    ).rejects.toBeInstanceOf(SettingsScopeForbidden);
  });

  it("rejects a manually entered non-current slug before profile access", async () => {
    const repository = WorkspaceRepository.of({
      findByUser: () => Effect.succeed(Option.some(membership)),
      createOwnedByUser: () => Effect.die("not used"),
      updateProfile: () => Effect.die("not used"),
    });
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkspaceProfileService;
          return yield* service.get(
            principal,
            Schema.decodeUnknownSync(
              WorkspaceMembership.fields.workspace.fields.shortName,
            )("other-team"),
          );
        }).pipe(Effect.provide(layerFor(repository, []))),
      ),
    ).rejects.toBeInstanceOf(SettingsScopeForbidden);
  });
});
