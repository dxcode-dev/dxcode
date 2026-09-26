import {
  configReferenceFor,
  EnvironmentVariableAuditId,
  EnvironmentVariableAuditRecord,
  EnvironmentVariableConflict,
  EnvironmentVariableId,
  type EnvironmentVariableAuditAction,
  type EnvironmentVariableAuditEvent,
  type EnvironmentVariableKind,
  type EnvironmentVariableName,
  type EnvironmentVariablePlaintext,
  EnvironmentVariableRepository,
  type EnvironmentVariableTarget,
  MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS,
  MAX_ENVIRONMENT_VARIABLES_PER_SCOPE,
  type ProjectId,
  type Page,
  type PageRequest,
  StoredEnvironmentVariable,
  type UserId,
  WorkspaceRepository,
} from "@dx/domain";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { SettingsAudit } from "../audit.js";
import {
  type ConfigEncryptionKeyring,
  decryptEnvironmentVariable,
  encryptEnvironmentVariable,
} from "./encryption.js";

export const ENVIRONMENT_VARIABLE_PRECEDENCE = [
  "personal",
  "project",
  "workspace",
] as const;

export class EnvironmentVariableLimitExceeded extends Schema.TaggedError<EnvironmentVariableLimitExceeded>()(
  "EnvironmentVariableLimitExceeded",
  {},
) {}

export interface EnvironmentVariableView {
  readonly stored: StoredEnvironmentVariable;
  readonly value: string;
}

export interface ResolvedEnvironmentVariable {
  readonly reference: ReturnType<typeof configReferenceFor>;
  readonly name: EnvironmentVariableName;
  readonly kind: EnvironmentVariableKind;
  readonly value: Redacted.Redacted<string>;
  readonly source: (typeof ENVIRONMENT_VARIABLE_PRECEDENCE)[number];
}

export interface BulkEnvironmentVariableInput {
  readonly name: EnvironmentVariableName;
  readonly value: EnvironmentVariablePlaintext;
}

interface EnvironmentVariableServiceShape {
  readonly list: (
    keyring: ConfigEncryptionKeyring,
    target: EnvironmentVariableTarget,
  ) => Effect.Effect<ReadonlyArray<EnvironmentVariableView>, unknown>;
  readonly create: (
    keyring: ConfigEncryptionKeyring,
    target: EnvironmentVariableTarget,
    input: {
      readonly name: EnvironmentVariableName;
      readonly kind: EnvironmentVariableKind;
      readonly value: EnvironmentVariablePlaintext;
    },
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<StoredEnvironmentVariable, unknown>;
  readonly updateState: (
    target: EnvironmentVariableTarget,
    id: EnvironmentVariableId,
    input: { readonly enabled?: boolean },
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<StoredEnvironmentVariable, unknown>;
  readonly rotate: (
    keyring: ConfigEncryptionKeyring,
    target: EnvironmentVariableTarget,
    id: EnvironmentVariableId,
    value: EnvironmentVariablePlaintext,
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<StoredEnvironmentVariable, unknown>;
  readonly remove: (
    target: EnvironmentVariableTarget,
    id: EnvironmentVariableId,
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<void, unknown>;
  readonly applyBulk: (
    keyring: ConfigEncryptionKeyring,
    target: EnvironmentVariableTarget,
    kind: EnvironmentVariableKind,
    values: ReadonlyArray<BulkEnvironmentVariableInput>,
    conflictBehavior: "reject" | "replace",
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<ReadonlyArray<StoredEnvironmentVariable>, unknown>;
  readonly resolveForExecution: (
    keyring: ConfigEncryptionKeyring,
    ownerUserId: UserId,
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ResolvedEnvironmentVariable>, unknown>;
  readonly listAudit: (
    target: EnvironmentVariableTarget,
    request: PageRequest,
  ) => Effect.Effect<Page<EnvironmentVariableAuditEvent>, unknown>;
}

const encryptionContext = (stored: StoredEnvironmentVariable) => ({
  id: stored.id,
  target: stored.target,
  name: stored.name,
  kind: stored.kind,
});

const targetAuditScope = (target: EnvironmentVariableTarget) => target.scope;

export class EnvironmentVariableService extends Context.Service<
  EnvironmentVariableService,
  EnvironmentVariableServiceShape
>()("@dx/core/settings/environment-variables/EnvironmentVariableService") {
  static readonly layer = Layer.effect(
    EnvironmentVariableService,
    Effect.gen(function* () {
      const repository = yield* EnvironmentVariableRepository;
      const workspaces = yield* WorkspaceRepository;
      const settingsAudit = yield* SettingsAudit;

      const recordAudit = (
        action: string,
        target: EnvironmentVariableTarget,
        audit: { readonly userId: UserId; readonly requestId: string },
        metadata: {
          readonly id?: EnvironmentVariableId;
          readonly kind?: EnvironmentVariableKind;
          readonly itemCount?: number;
        },
      ) =>
        settingsAudit.record({
          action,
          scope: targetAuditScope(target),
          outcome: "success",
          requestId: audit.requestId,
          userId: audit.userId,
          ...(metadata.id === undefined
            ? {}
            : { environmentVariableId: metadata.id }),
          ...(metadata.kind === undefined
            ? {}
            : { environmentVariableKind: metadata.kind }),
          ...(metadata.itemCount === undefined
            ? {}
            : { itemCount: metadata.itemCount }),
        });

      const createStored = Effect.fn("EnvironmentVariableService.createStored")(
        function* (
          keyring: ConfigEncryptionKeyring,
          target: EnvironmentVariableTarget,
          input: {
            readonly name: EnvironmentVariableName;
            readonly kind: EnvironmentVariableKind;
            readonly value: EnvironmentVariablePlaintext;
          },
        ) {
          const id = yield* Schema.decodeUnknownEffect(EnvironmentVariableId)(
            `env_${crypto.randomUUID()}`,
          );
          const now = yield* DateTime.now;
          const envelope = yield* encryptEnvironmentVariable(
            keyring,
            { id, target, name: input.name, kind: input.kind },
            input.value,
          );
          return yield* Schema.decodeUnknownEffect(
            Schema.toType(StoredEnvironmentVariable),
          )({
            id,
            target,
            name: input.name,
            kind: input.kind,
            enabled: true,
            envelope,
            createdAt: now,
            updatedAt: now,
            rotatedAt: now,
          });
        },
      );

      const decrypt = (keyring: ConfigEncryptionKeyring) =>
        Effect.fn("EnvironmentVariableService.decrypt")(function* (
          stored: StoredEnvironmentVariable,
        ) {
          return yield* decryptEnvironmentVariable(
            keyring,
            encryptionContext(stored),
            stored.envelope,
          );
        });

      const mutationAudit = Effect.fn(
        "EnvironmentVariableService.mutationAudit",
      )(function* (
        value: StoredEnvironmentVariable,
        action: EnvironmentVariableAuditAction,
        audit: { readonly userId: UserId; readonly requestId: string },
        occurredAt = value.updatedAt,
      ) {
        const id = yield* Schema.decodeUnknownEffect(
          EnvironmentVariableAuditId,
        )(`eva_${crypto.randomUUID()}`);
        return yield* Schema.decodeUnknownEffect(
          Schema.toType(EnvironmentVariableAuditRecord),
        )({
          id,
          target: value.target,
          variableId: value.id,
          name: value.name,
          kind: value.kind,
          action,
          actorUserId: audit.userId,
          requestId: audit.requestId,
          occurredAt,
        });
      });

      return EnvironmentVariableService.of({
        list: Effect.fn("EnvironmentVariableService.list")(
          function* (keyring, target) {
            const values = yield* repository.list(target);
            return yield* Effect.all(
              values.map((stored) =>
                stored.kind === "secret"
                  ? Effect.succeed({ stored, value: "••••••••" })
                  : decrypt(keyring)(stored).pipe(
                      Effect.map((value) => ({ stored, value })),
                    ),
              ),
              { concurrency: 4 },
            );
          },
        ),
        create: Effect.fn("EnvironmentVariableService.create")(
          function* (keyring, target, input, audit) {
            const existing = yield* repository.list(target);
            if (existing.length >= MAX_ENVIRONMENT_VARIABLES_PER_SCOPE) {
              return yield* new EnvironmentVariableLimitExceeded();
            }
            if (
              Option.isSome(yield* repository.findByName(target, input.name))
            ) {
              return yield* new EnvironmentVariableConflict();
            }
            const stored = yield* createStored(keyring, target, input);
            yield* repository.write([
              {
                operation: "insert",
                value: stored,
                audit: yield* mutationAudit(stored, "create", audit),
              },
            ]);
            yield* recordAudit("environment_variable.create", target, audit, {
              id: stored.id,
              kind: stored.kind,
            });
            return stored;
          },
        ),
        updateState: Effect.fn("EnvironmentVariableService.updateState")(
          function* (target, id, input, audit) {
            const current = yield* repository.find(target, id);
            const updatedAt = yield* DateTime.now;
            const updated = yield* Schema.decodeUnknownEffect(
              Schema.toType(StoredEnvironmentVariable),
            )({
              ...current,
              enabled: input.enabled ?? current.enabled,
              updatedAt,
            });
            yield* repository.write([
              {
                operation: "replace",
                value: updated,
                audit: yield* mutationAudit(updated, "update", audit),
              },
            ]);
            yield* recordAudit("environment_variable.update", target, audit, {
              id,
              kind: current.kind,
            });
            return updated;
          },
        ),
        rotate: Effect.fn("EnvironmentVariableService.rotate")(
          function* (keyring, target, id, value, audit) {
            const current = yield* repository.find(target, id);
            const now = yield* DateTime.now;
            const envelope = yield* encryptEnvironmentVariable(
              keyring,
              encryptionContext(current),
              value,
            );
            const updated = yield* Schema.decodeUnknownEffect(
              Schema.toType(StoredEnvironmentVariable),
            )({
              ...current,
              envelope,
              enabled: true,
              updatedAt: now,
              rotatedAt: now,
            });
            yield* repository.write([
              {
                operation: "replace",
                value: updated,
                audit: yield* mutationAudit(updated, "rotate", audit),
              },
            ]);
            yield* recordAudit("environment_variable.rotate", target, audit, {
              id,
              kind: current.kind,
            });
            return updated;
          },
        ),
        remove: Effect.fn("EnvironmentVariableService.remove")(
          function* (target, id, audit) {
            const current = yield* repository.find(target, id);
            const occurredAt = yield* DateTime.now;
            yield* repository.remove(
              target,
              id,
              yield* mutationAudit(current, "delete", audit, occurredAt),
            );
            yield* recordAudit("environment_variable.delete", target, audit, {
              id,
              kind: current.kind,
            });
          },
        ),
        applyBulk: Effect.fn("EnvironmentVariableService.applyBulk")(
          function* (keyring, target, kind, values, conflictBehavior, audit) {
            if (
              values.length === 0 ||
              values.length > MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS
            ) {
              return yield* new EnvironmentVariableLimitExceeded();
            }
            const existing = yield* repository.list(target);
            const existingByName = new Map(
              existing.map((value) => [value.name, value]),
            );
            const conflicts = values.filter(({ name }) =>
              existingByName.has(name),
            );
            if (conflictBehavior === "reject" && conflicts.length > 0) {
              return yield* new EnvironmentVariableConflict();
            }
            const createdCount = values.length - conflicts.length;
            if (
              existing.length + createdCount >
              MAX_ENVIRONMENT_VARIABLES_PER_SCOPE
            ) {
              return yield* new EnvironmentVariableLimitExceeded();
            }
            const writes: Array<{
              readonly operation: "insert" | "replace";
              readonly value: StoredEnvironmentVariable;
              readonly audit: EnvironmentVariableAuditRecord;
            }> = [];
            for (const value of values) {
              const current = existingByName.get(value.name);
              if (current === undefined) {
                const stored = yield* createStored(keyring, target, {
                  ...value,
                  kind,
                });
                writes.push({
                  operation: "insert",
                  value: stored,
                  audit: yield* mutationAudit(stored, "create", audit),
                });
                continue;
              }
              const now = yield* DateTime.now;
              const nextContext = { ...current, kind };
              const envelope = yield* encryptEnvironmentVariable(
                keyring,
                encryptionContext(nextContext),
                value.value,
              );
              const replacement = yield* Schema.decodeUnknownEffect(
                Schema.toType(StoredEnvironmentVariable),
              )({
                ...current,
                kind,
                enabled: true,
                envelope,
                updatedAt: now,
                rotatedAt: now,
              });
              writes.push({
                operation: "replace",
                value: replacement,
                audit: yield* mutationAudit(replacement, "rotate", audit),
              });
            }
            yield* repository.write(writes);
            yield* recordAudit(
              "environment_variable.bulk_apply",
              target,
              audit,
              { kind, itemCount: writes.length },
            );
            return writes.map(({ value }) => value);
          },
        ),
        resolveForExecution: Effect.fn(
          "EnvironmentVariableService.resolveForExecution",
        )(function* (keyring, ownerUserId, projectId) {
          const personal = yield* repository.list({
            scope: "personal",
            id: ownerUserId,
          });
          const project = yield* repository.list({
            scope: "project",
            id: projectId,
          });
          const membership = yield* workspaces.findByUser(ownerUserId);
          const workspace = Option.isSome(membership)
            ? yield* repository.list({
                scope: "workspace",
                id: membership.value.workspace.id,
              })
            : [];
          const candidates = [
            ...personal
              .filter((value) => value.enabled)
              .map((value) => ({ value, source: "personal" as const })),
            ...project
              .filter((value) => value.enabled)
              .map((value) => ({ value, source: "project" as const })),
            ...workspace
              .filter((value) => value.enabled)
              .map((value) => ({ value, source: "workspace" as const })),
          ];
          const selected = new Map<
            EnvironmentVariableName,
            (typeof candidates)[number]
          >();
          for (const candidate of candidates) {
            if (!selected.has(candidate.value.name)) {
              selected.set(candidate.value.name, candidate);
            }
          }
          return yield* Effect.all(
            [...selected.values()]
              .sort((left, right) =>
                left.value.name.localeCompare(right.value.name),
              )
              .map(({ value, source }) =>
                decrypt(keyring)(value).pipe(
                  Effect.map((plaintext) => ({
                    reference: configReferenceFor(value.id),
                    name: value.name,
                    kind: value.kind,
                    value: Redacted.make(plaintext),
                    source,
                  })),
                ),
              ),
            { concurrency: 4 },
          );
        }),
        listAudit: (target, request) => repository.listAudit(target, request),
      });
    }),
  );
}
