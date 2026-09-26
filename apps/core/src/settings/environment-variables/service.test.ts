import {
  EnvironmentVariableConflict,
  type EnvironmentVariableAuditEvent,
  EnvironmentVariableId,
  EnvironmentVariableName,
  EnvironmentVariableNotFound,
  EnvironmentVariablePlaintext,
  EnvironmentVariableRepository,
  type EnvironmentVariableTarget,
  ProjectId,
  type StoredEnvironmentVariable,
  UserId,
  WorkspaceId,
  WorkspaceMembership,
  WorkspaceRepository,
} from "@dx/domain";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit, type SettingsAuditEvent } from "../audit.js";
import { loadConfigEncryptionKeyring } from "./encryption.js";
import { EnvironmentVariableService } from "./service.js";

const keyringBinding = {
  DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({
    activeVersion: 1,
    keys: { 1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
  }),
};
const ownerUserId = Schema.decodeUnknownSync(UserId)("owner-user");
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_11111111-1111-4111-8111-111111111111",
);
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-one");
const personalTarget = {
  scope: "personal" as const,
  id: ownerUserId,
};
const projectTarget = { scope: "project" as const, id: projectId };
const workspaceTarget = { scope: "workspace" as const, id: workspaceId };
const name = (value: string) =>
  Schema.decodeUnknownSync(EnvironmentVariableName)(value);
const plaintext = (value: string) =>
  Schema.decodeUnknownSync(EnvironmentVariablePlaintext)(value);

const sameTarget = (
  left: EnvironmentVariableTarget,
  right: EnvironmentVariableTarget,
) => left.scope === right.scope && left.id === right.id;

const harness = () => {
  const values: Array<StoredEnvironmentVariable> = [];
  const auditEvents: Array<EnvironmentVariableAuditEvent> = [];
  const events: Array<SettingsAuditEvent> = [];
  const repository = EnvironmentVariableRepository.of({
    list: (target) =>
      Effect.succeed(
        values.filter((value) => sameTarget(value.target, target)),
      ),
    find: (target, id) => {
      const value = values.find(
        (candidate) =>
          candidate.id === id && sameTarget(candidate.target, target),
      );
      return value === undefined
        ? Effect.fail(new EnvironmentVariableNotFound())
        : Effect.succeed(value);
    },
    findByName: (target, targetName) =>
      Effect.succeed(
        Option.fromNullishOr(
          values.find(
            (candidate) =>
              candidate.name === targetName &&
              sameTarget(candidate.target, target),
          ),
        ),
      ),
    write: (writes) =>
      Effect.gen(function* () {
        const next = [...values];
        for (const write of writes) {
          if (write.operation === "insert") {
            if (
              next.some(
                (candidate) =>
                  candidate.name === write.value.name &&
                  sameTarget(candidate.target, write.value.target),
              )
            ) {
              return yield* new EnvironmentVariableConflict();
            }
            next.push(write.value);
          } else {
            const index = next.findIndex(
              (candidate) =>
                candidate.id === write.value.id &&
                sameTarget(candidate.target, write.value.target),
            );
            if (index < 0) return yield* new EnvironmentVariableNotFound();
            next[index] = write.value;
          }
        }
        yield* Effect.sync(() => {
          values.splice(0, values.length, ...next);
          auditEvents.push(
            ...writes.map(({ audit: event }) => ({
              ...event,
              actorName: "Synthetic Owner",
            })),
          );
        });
      }),
    remove: (target, id, event) =>
      Effect.gen(function* () {
        const index = values.findIndex(
          (candidate) =>
            candidate.id === id && sameTarget(candidate.target, target),
        );
        if (index < 0) return yield* new EnvironmentVariableNotFound();
        yield* Effect.sync(() => {
          values.splice(index, 1);
          auditEvents.push({ ...event, actorName: "Synthetic Owner" });
        });
      }),
    listAudit: (target) =>
      Effect.succeed({
        items: auditEvents.filter((event) => sameTarget(event.target, target)),
      }),
  });
  const workspace = WorkspaceRepository.of({
    findByUser: () =>
      Effect.succeed(
        Option.some(
          Schema.decodeUnknownSync(WorkspaceMembership)({
            workspace: {
              id: workspaceId,
              displayName: "Synthetic Team",
              shortName: "synthetic-team",
              lifecycleState: "active",
              revision: 0,
            },
            userId: ownerUserId,
            role: "owner",
          }),
        ),
      ),
    createOwnedByUser: () => Effect.die("not used"),
    updateProfile: () => Effect.die("not used"),
  });
  const audit = SettingsAudit.of({
    record: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  });
  const layer = EnvironmentVariableService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(EnvironmentVariableRepository, repository),
        Layer.succeed(WorkspaceRepository, workspace),
        Layer.succeed(SettingsAudit, audit),
      ),
    ),
  );
  return {
    events,
    auditEvents,
    layer,
    stored: () => values,
  };
};

const audit = { userId: ownerUserId, requestId: "request-synthetic" };

describe("EnvironmentVariableService", () => {
  it("persists only envelopes, masks secrets, rotates, disables, and deletes", async () => {
    const test = harness();
    const secret = "synthetic-secret-value";
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keyring = yield* loadConfigEncryptionKeyring(keyringBinding);
        const service = yield* EnvironmentVariableService;
        const created = yield* service.create(
          keyring,
          personalTarget,
          {
            name: name("BUILD_CHANNEL"),
            kind: "secret",
            value: plaintext(secret),
          },
          audit,
        );
        const listed = yield* service.list(keyring, personalTarget);
        const disabled = yield* service.updateState(
          personalTarget,
          created.id,
          { enabled: false },
          audit,
        );
        const rotated = yield* service.rotate(
          keyring,
          personalTarget,
          created.id,
          plaintext("replacement-secret-value"),
          audit,
        );
        yield* service.remove(personalTarget, created.id, audit);
        return { created, disabled, listed, rotated };
      }).pipe(Effect.provide(test.layer)),
    );

    expect(JSON.stringify(result.created)).not.toContain(secret);
    expect(result.listed[0]?.value).toBe("••••••••");
    expect(result.disabled.enabled).toBe(false);
    expect(result.rotated.enabled).toBe(true);
    expect(result.rotated.envelope).not.toEqual(result.created.envelope);
    expect(test.stored()).toEqual([]);
    expect(JSON.stringify(test.events)).not.toMatch(
      /BUILD_CHANNEL|synthetic-secret|replacement-secret/,
    );
    expect(test.events.map(({ action }) => action)).toEqual([
      "environment_variable.create",
      "environment_variable.update",
      "environment_variable.rotate",
      "environment_variable.delete",
    ]);
    expect(test.auditEvents.map(({ action }) => action)).toEqual([
      "create",
      "update",
      "rotate",
      "delete",
    ]);
    expect(JSON.stringify(test.auditEvents)).not.toMatch(
      /synthetic-secret|replacement-secret/,
    );
  });

  it("isolates scopes and resolves personal, then project, then workspace", async () => {
    const test = harness();
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const keyring = yield* loadConfigEncryptionKeyring(keyringBinding);
        const service = yield* EnvironmentVariableService;
        const create = (
          target: EnvironmentVariableTarget,
          targetName: string,
          value: string,
        ) =>
          service.create(
            keyring,
            target,
            {
              name: name(targetName),
              kind: "variable",
              value: plaintext(value),
            },
            audit,
          );
        const personalShared = yield* create(
          personalTarget,
          "SHARED_NAME",
          "personal",
        );
        yield* create(projectTarget, "SHARED_NAME", "project");
        yield* create(workspaceTarget, "SHARED_NAME", "workspace");
        const workspaceOnly = yield* create(
          workspaceTarget,
          "WORKSPACE_ONLY",
          "workspace-only",
        );
        const beforeDisable = yield* service.resolveForExecution(
          keyring,
          ownerUserId,
          projectId,
        );
        yield* service.updateState(
          personalTarget,
          personalShared.id,
          { enabled: false },
          audit,
        );
        yield* service.updateState(
          workspaceTarget,
          workspaceOnly.id,
          { enabled: false },
          audit,
        );
        const afterDisable = yield* service.resolveForExecution(
          keyring,
          ownerUserId,
          projectId,
        );
        return { afterDisable, beforeDisable };
      }).pipe(Effect.provide(test.layer)),
    );

    expect(
      resolved.beforeDisable.map(({ name, value, source }) => ({
        name,
        value: Redacted.value(value),
        source,
      })),
    ).toEqual([
      { name: "SHARED_NAME", value: "personal", source: "personal" },
      { name: "WORKSPACE_ONLY", value: "workspace-only", source: "workspace" },
    ]);
    expect(
      resolved.afterDisable.map(({ name, value, source }) => ({
        name,
        value: Redacted.value(value),
        source,
      })),
    ).toEqual([
      {
        name: "SHARED_NAME",
        value: "project",
        source: "project",
      },
    ]);
  });

  it("applies bulk conflicts deterministically with reject or replace", async () => {
    const test = harness();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const keyring = yield* loadConfigEncryptionKeyring(keyringBinding);
        const service = yield* EnvironmentVariableService;
        const current = yield* service.create(
          keyring,
          projectTarget,
          {
            name: name("BUILD_CHANNEL"),
            kind: "variable",
            value: plaintext("old-value"),
          },
          audit,
        );
        const input = [
          { name: name("BUILD_CHANNEL"), value: plaintext("new-value") },
          { name: name("SECOND_VALUE"), value: plaintext("second-value") },
        ];
        const rejected = yield* Effect.flip(
          service.applyBulk(
            keyring,
            projectTarget,
            "secret",
            input,
            "reject",
            audit,
          ),
        );
        const replaced = yield* service.applyBulk(
          keyring,
          projectTarget,
          "secret",
          input,
          "replace",
          audit,
        );
        return { current, rejected, replaced };
      }).pipe(Effect.provide(test.layer)),
    );

    expect(result.rejected).toBeInstanceOf(EnvironmentVariableConflict);
    expect(result.replaced).toHaveLength(2);
    expect(result.replaced[0]?.id).toBe(result.current.id);
    expect(result.replaced.every(({ kind }) => kind === "secret")).toBe(true);
    expect(JSON.stringify(test.stored())).not.toMatch(/new-value|second-value/);
  });

  it("does not allow an identifier to cross scope boundaries", async () => {
    const test = harness();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const keyring = yield* loadConfigEncryptionKeyring(keyringBinding);
        const service = yield* EnvironmentVariableService;
        const created = yield* service.create(
          keyring,
          personalTarget,
          {
            name: name("SCOPE_ONLY"),
            kind: "variable",
            value: plaintext("personal-only"),
          },
          audit,
        );
        return yield* Effect.flip(
          service.rotate(
            keyring,
            projectTarget,
            Schema.decodeUnknownSync(EnvironmentVariableId)(created.id),
            plaintext("cross-scope"),
            audit,
          ),
        );
      }).pipe(Effect.provide(test.layer)),
    );
    expect(failure).toBeInstanceOf(EnvironmentVariableNotFound);
  });
});
