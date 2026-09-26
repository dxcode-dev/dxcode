import {
  CreateWorkspaceInput,
  UpdateWorkspaceProfileInput,
  UserId,
  WorkspaceMembershipExists,
  WorkspaceProfileConflict,
  WorkspaceRepository,
  WorkspaceShortNameUnavailable,
} from "@dx/domain";
import { env } from "cloudflare:test";
import { Effect, Option, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { runRepositories } from "./runtime.js";

const owner = Schema.decodeUnknownSync(UserId)("workspace-repository-owner");
const other = Schema.decodeUnknownSync(UserId)("workspace-repository-other");

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Workspace Owner", "workspace-owner@example.com", 1, 1),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(other, "Workspace Other", "workspace-other@example.com", 1, 1),
  ]);
});

const createInput = (displayName: string, shortName: string) =>
  Schema.decodeUnknownSync(CreateWorkspaceInput)({ displayName, shortName });

describe("WorkspaceRepository D1", () => {
  it("creates one owner membership and preserves stable identity across rename", async () => {
    await runRepositories(
      Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        expect(Option.isNone(yield* repository.findByUser(owner))).toBe(true);
        const membership = yield* repository.createOwnedByUser(
          owner,
          createInput("DX Team", "dx-team"),
        );
        expect(membership).toMatchObject({
          workspace: {
            displayName: "DX Team",
            shortName: "dx-team",
            lifecycleState: "active",
          },
          role: "owner",
        });
        const stableId = membership.workspace.id;
        const updated = yield* repository.updateProfile(
          stableId,
          Schema.decodeUnknownSync(UpdateWorkspaceProfileInput)({
            displayName: "Renamed DX",
            shortName: "renamed-dx",
          }),
          0,
        );
        expect(updated).toMatchObject({
          id: stableId,
          displayName: "Renamed DX",
          shortName: "renamed-dx",
        });
        const current = yield* repository.findByUser(owner);
        expect(Option.getOrThrow(current).workspace.id).toBe(stableId);
      }),
    );
  });

  it("returns typed second-membership and global short-name conflicts", async () => {
    await runRepositories(
      Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        yield* repository.createOwnedByUser(
          owner,
          createInput("DX Team", "dx-team"),
        );
        const second = yield* Effect.flip(
          repository.createOwnedByUser(
            owner,
            createInput("Second Team", "second-team"),
          ),
        );
        expect(second).toBeInstanceOf(WorkspaceMembershipExists);

        const duplicate = yield* Effect.flip(
          repository.createOwnedByUser(
            other,
            createInput("Duplicate Team", "dx-team"),
          ),
        );
        expect(duplicate).toBeInstanceOf(WorkspaceShortNameUnavailable);
        expect(Option.isNone(yield* repository.findByUser(other))).toBe(true);
      }),
    );
  });

  it("allows only one of two writers using the same profile revision", async () => {
    await runRepositories(
      Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        const membership = yield* repository.createOwnedByUser(
          owner,
          createInput("DX Team", "dx-team"),
        );
        yield* repository.updateProfile(
          membership.workspace.id,
          Schema.decodeUnknownSync(UpdateWorkspaceProfileInput)({
            displayName: "First Writer",
            shortName: "first-writer",
          }),
          0,
        );
        const stale = yield* Effect.flip(
          repository.updateProfile(
            membership.workspace.id,
            Schema.decodeUnknownSync(UpdateWorkspaceProfileInput)({
              displayName: "Second Writer",
              shortName: "second-writer",
            }),
            0,
          ),
        );

        expect(stale).toBeInstanceOf(WorkspaceProfileConflict);
        expect(stale).toMatchObject({ currentRevision: 1 });
      }),
    );
  });
});
