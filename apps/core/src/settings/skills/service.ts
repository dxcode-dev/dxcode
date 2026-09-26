import {
  MAX_SKILLS_PER_SCOPE,
  McpServerRepository,
  type PersistenceUnavailable,
  type Principal,
  type ProjectId,
  type ResolvedSkillSnapshot,
  SkillId,
  type SkillImportBundle,
  type SkillIntegrity,
  SkillIntegrityConflict,
  SkillLimitExceeded,
  SkillMcpReferenceInvalid,
  SkillRepository,
  type SkillTarget,
  SkillVersion,
  type SkillWithVersion,
  StoredSkill,
  StoredSkillVersion,
  type UserId,
  type WorkspaceId,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { previewSkillImport, type SkillPreview } from "./import.js";

interface AuditContext {
  readonly userId: UserId;
  readonly requestId: string;
}

interface SkillStateInput {
  readonly enabled?: boolean;
  readonly activeVersion?: typeof SkillVersion.Type;
  readonly pinned?: boolean;
}

interface SkillServiceShape {
  readonly preview: (
    bundle: SkillImportBundle,
  ) => ReturnType<typeof previewSkillImport>;
  readonly list: (
    target: SkillTarget,
  ) => ReturnType<typeof SkillRepository.Service.list>;
  readonly create: (
    target: SkillTarget,
    bundle: SkillImportBundle,
    reviewedIntegrity: SkillIntegrity,
    audit: AuditContext,
  ) => Effect.Effect<SkillWithVersion, unknown>;
  readonly update: (
    target: SkillTarget,
    id: typeof SkillId.Type,
    bundle: SkillImportBundle,
    reviewedIntegrity: SkillIntegrity,
    activate: boolean,
    audit: AuditContext,
  ) => Effect.Effect<SkillWithVersion, unknown>;
  readonly changeState: (
    target: SkillTarget,
    id: typeof SkillId.Type,
    input: SkillStateInput,
    audit: AuditContext,
  ) => Effect.Effect<SkillWithVersion, unknown>;
  readonly remove: (
    target: SkillTarget,
    id: typeof SkillId.Type,
    audit: AuditContext,
  ) => Effect.Effect<void, unknown>;
  readonly exportVersion: (
    target: SkillTarget,
    id: typeof SkillId.Type,
    version?: typeof SkillVersion.Type,
  ) => Effect.Effect<StoredSkillVersion, unknown>;
  readonly resolveForThread: (
    principal: Principal,
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ResolvedSkillSnapshot>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly getWorkspacePolicy: (
    workspaceId: WorkspaceId,
  ) => ReturnType<typeof SkillRepository.Service.getWorkspacePolicy>;
  readonly setWorkspacePolicy: (
    workspaceId: WorkspaceId,
    allowPersonal: boolean,
    audit: AuditContext,
  ) => Effect.Effect<void, unknown>;
}

export class SkillService extends Context.Service<
  SkillService,
  SkillServiceShape
>()("@dx/core/settings/skills/SkillService") {
  static readonly layer = Layer.effect(
    SkillService,
    Effect.gen(function* () {
      const repository = yield* SkillRepository;
      const mcpServers = yield* McpServerRepository;
      const settingsAudit = yield* SettingsAudit;

      const audit = (
        action: string,
        target: SkillTarget,
        context: AuditContext,
        skillId?: typeof SkillId.Type,
        skillVersion?: number,
      ) =>
        settingsAudit.record({
          action,
          scope: target.scope,
          outcome: "success",
          requestId: context.requestId,
          userId: context.userId,
          ...(skillId === undefined ? {} : { skillId }),
          ...(skillVersion === undefined ? {} : { skillVersion }),
        });

      const requireReviewedMcp = Effect.fn("SkillService.requireReviewedMcp")(
        function* (
          target: SkillTarget,
          preview: Pick<SkillPreview, "manifest">,
        ) {
          yield* Effect.all(
            preview.manifest.mcpServerIds.map((id) =>
              mcpServers.find(target, id).pipe(
                Effect.flatMap(({ server, tools }) =>
                  server.enabled &&
                  tools.some(
                    (tool) =>
                      tool.approvedSchemaHash !== undefined &&
                      tool.approvedSchemaHash === tool.schemaHash,
                  )
                    ? Effect.void
                    : Effect.fail(new SkillMcpReferenceInvalid()),
                ),
                Effect.catchTag("McpServerNotFound", () =>
                  Effect.fail(new SkillMcpReferenceInvalid()),
                ),
              ),
            ),
            { concurrency: 4 },
          );
        },
      );

      const checkedPreview = Effect.fn("SkillService.checkedPreview")(
        function* (bundle: SkillImportBundle, expected: SkillIntegrity) {
          const preview = yield* previewSkillImport(bundle);
          if (preview.integrity !== expected) {
            return yield* new SkillIntegrityConflict();
          }
          return preview;
        },
      );

      const makeVersion = Effect.fn("SkillService.makeVersion")(function* (
        skillId: typeof SkillId.Type,
        version: typeof SkillVersion.Type,
        preview: SkillPreview,
        createdByUserId: UserId,
      ) {
        const createdAt = yield* DateTime.now;
        return yield* Schema.decodeUnknownEffect(
          Schema.toType(StoredSkillVersion),
        )({
          skillId,
          version,
          manifest: preview.manifest,
          instructions: preview.instructions,
          resources: preview.resources,
          source: preview.source,
          integrity: preview.integrity,
          createdAt,
          createdByUserId,
        });
      });

      return SkillService.of({
        preview: previewSkillImport,
        list: repository.list,
        create: Effect.fn("SkillService.create")(
          function* (target, bundle, reviewedIntegrity, auditContext) {
            const existing = yield* repository.list(target);
            if (existing.length >= MAX_SKILLS_PER_SCOPE) {
              return yield* new SkillLimitExceeded();
            }
            const preview = yield* checkedPreview(bundle, reviewedIntegrity);
            const id = yield* Schema.decodeEffect(SkillId)(
              `skl_${crypto.randomUUID()}`,
            );
            const versionNumber = yield* Schema.decodeEffect(SkillVersion)(1);
            const version = yield* makeVersion(
              id,
              versionNumber,
              preview,
              auditContext.userId,
            );
            const now = version.createdAt;
            const skill = yield* Schema.decodeUnknownEffect(
              Schema.toType(StoredSkill),
            )({
              id,
              target,
              name: preview.manifest.name,
              enabled: false,
              activeVersion: versionNumber,
              pinned: false,
              createdAt: now,
              updatedAt: now,
            });
            yield* repository.insert(skill, version);
            yield* audit(
              "skill.import",
              target,
              auditContext,
              id,
              versionNumber,
            );
            return yield* repository.find(target, id);
          },
        ),
        update: Effect.fn("SkillService.update")(
          function* (
            target,
            id,
            bundle,
            reviewedIntegrity,
            activate,
            auditContext,
          ) {
            const current = yield* repository.find(target, id);
            const preview = yield* checkedPreview(bundle, reviewedIntegrity);
            if (preview.manifest.name !== current.skill.name) {
              return yield* new SkillIntegrityConflict();
            }
            if (activate) yield* requireReviewedMcp(target, preview);
            const latest = Math.max(...current.versions);
            const versionNumber = yield* Schema.decodeEffect(SkillVersion)(
              latest + 1,
            );
            const version = yield* makeVersion(
              id,
              versionNumber,
              preview,
              auditContext.userId,
            );
            yield* repository.insertVersion(
              target,
              version,
              activate,
              version.createdAt,
            );
            yield* audit(
              activate ? "skill.update_activate" : "skill.update_publish",
              target,
              auditContext,
              id,
              versionNumber,
            );
            return yield* repository.find(target, id);
          },
        ),
        changeState: Effect.fn("SkillService.changeState")(
          function* (target, id, input, auditContext) {
            const current = yield* repository.find(target, id);
            const activeVersion =
              input.activeVersion ?? current.skill.activeVersion;
            if (
              current.skill.pinned &&
              activeVersion !== current.skill.activeVersion &&
              input.pinned !== false
            ) {
              return yield* new SkillIntegrityConflict();
            }
            if (input.enabled === true || input.activeVersion !== undefined) {
              const version = yield* repository.findVersion(id, activeVersion);
              yield* requireReviewedMcp(target, version);
            }
            const updatedAt = yield* DateTime.now;
            yield* repository.updateState(target, id, input, updatedAt);
            yield* audit(
              input.activeVersion !== undefined
                ? "skill.version_activate"
                : input.enabled === false
                  ? "skill.disable"
                  : input.enabled === true
                    ? "skill.enable"
                    : "skill.pin",
              target,
              auditContext,
              id,
              activeVersion,
            );
            return yield* repository.find(target, id);
          },
        ),
        remove: Effect.fn("SkillService.remove")(
          function* (target, id, auditContext) {
            const removedAt = yield* DateTime.now;
            yield* repository.updateState(
              target,
              id,
              { enabled: false, removedAt },
              removedAt,
            );
            yield* audit("skill.remove", target, auditContext, id);
          },
        ),
        exportVersion: Effect.fn("SkillService.exportVersion")(
          function* (target, id, version) {
            const current = yield* repository.find(target, id);
            return version === undefined
              ? current.active
              : yield* repository.findVersion(id, version);
          },
        ),
        resolveForThread: Effect.fn("SkillService.resolveForThread")(
          function* (principal, projectId) {
            const candidates = yield* repository.listEffectiveForThread(
              principal.userId,
              projectId,
            );
            const connections = yield* mcpServers.listForExecution(
              principal.userId,
              projectId,
            );
            const approvedServerIds = new Set(
              connections
                .filter(({ tools }) => tools.length > 0)
                .map(({ server }) => server.id),
            );
            const applicable = candidates.filter(({ active }) =>
              active.manifest.mcpServerIds.every((id) =>
                approvedServerIds.has(id),
              ),
            );
            const bounded: typeof applicable = [];
            let instructionBytes = 0;
            for (const candidate of applicable) {
              const nextBytes = new TextEncoder().encode(
                candidate.active.instructions,
              ).byteLength;
              if (
                bounded.length >= 20 ||
                instructionBytes + nextBytes > 65_536
              ) {
                continue;
              }
              instructionBytes += nextBytes;
              bounded.push(candidate);
            }
            return bounded.map(({ skill, active }) => ({
              id: skill.id,
              version: active.version,
              name: skill.name,
              scope: skill.target.scope,
              integrity: active.integrity,
            }));
          },
        ),
        getWorkspacePolicy: repository.getWorkspacePolicy,
        setWorkspacePolicy: Effect.fn("SkillService.setWorkspacePolicy")(
          function* (workspaceId, allowPersonal, auditContext) {
            yield* repository.setWorkspacePolicy(workspaceId, allowPersonal);
            yield* settingsAudit.record({
              action: "skill_workspace_policy.update",
              scope: "workspace",
              outcome: "success",
              requestId: auditContext.requestId,
              userId: auditContext.userId,
              workspaceId,
            });
          },
        ),
      });
    }),
  );
}
