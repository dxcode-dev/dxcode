import {
  type ExternalApiApplication,
  type ExternalApiApplicationAuditEvent,
  ExternalApiApplicationAuditEventId,
  ExternalApiApplicationCredentialId,
  ExternalApiApplicationId,
  type ExternalApiApplicationClientSecret,
  type ExternalApiApplicationName,
  ExternalApiApplicationRepository,
  type ExternalApiApplicationRateLimit,
  type ExternalApiApplicationRotationOverlapSeconds,
  type ExternalApiApplicationScopes,
  type ExternalApiApplicationStatus,
  type PageCursor,
  type Principal,
  type WorkspaceId,
  type WorkspacePermission,
  type WorkspaceShortName,
  WorkspacePermissionForbidden,
  workspacePermissionsForRole,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { ExternalApiApplicationCredentials } from "./credentials.js";

interface ApplicationInput {
  readonly name: ExternalApiApplicationName;
  readonly scopes: ExternalApiApplicationScopes;
  readonly rateLimitPerMinute: ExternalApiApplicationRateLimit;
}

interface ApplicationPage {
  readonly items: ReadonlyArray<ExternalApiApplication>;
  readonly nextCursor?: PageCursor;
  readonly permissions: ReadonlyArray<WorkspacePermission>;
}

interface ApplicationAuditPage {
  readonly items: ReadonlyArray<ExternalApiApplicationAuditEvent>;
  readonly nextCursor?: PageCursor;
}

interface ApplicationSecret {
  readonly application: ExternalApiApplication;
  readonly clientSecret: ExternalApiApplicationClientSecret;
}

interface AuditInput {
  readonly applicationId: ExternalApiApplicationId;
  readonly workspaceId: WorkspaceId;
  readonly principal: Principal;
  readonly action: string;
  readonly requestId: string;
  readonly scopes?: ExternalApiApplicationScopes;
  readonly now: number;
}

interface ExternalApiApplicationsServiceShape {
  readonly list: (
    principal: Principal,
    workspaceSlug: WorkspaceShortName,
    input: { readonly limit: number; readonly cursor?: PageCursor },
  ) => Effect.Effect<ApplicationPage, unknown>;
  readonly create: (
    principal: Principal,
    workspaceSlug: WorkspaceShortName,
    input: ApplicationInput,
    requestId: string,
  ) => Effect.Effect<ApplicationSecret, unknown>;
  readonly update: (
    principal: Principal,
    workspaceSlug: WorkspaceShortName,
    applicationId: ExternalApiApplicationId,
    input: ApplicationInput,
    requestId: string,
  ) => Effect.Effect<ExternalApiApplication, unknown>;
  readonly rotate: (
    principal: Principal,
    workspaceSlug: WorkspaceShortName,
    applicationId: ExternalApiApplicationId,
    overlapSeconds: ExternalApiApplicationRotationOverlapSeconds,
    requestId: string,
  ) => Effect.Effect<ApplicationSecret, unknown>;
  readonly setStatus: (
    principal: Principal,
    workspaceSlug: WorkspaceShortName,
    applicationId: ExternalApiApplicationId,
    status: ExternalApiApplicationStatus,
    requestId: string,
  ) => Effect.Effect<ExternalApiApplication, unknown>;
  readonly listAudit: (
    principal: Principal,
    workspaceSlug: WorkspaceShortName,
    applicationId: ExternalApiApplicationId,
    input: { readonly limit: number; readonly cursor?: PageCursor },
  ) => Effect.Effect<ApplicationAuditPage, unknown>;
}

export class ExternalApiApplicationsService extends Context.Service<
  ExternalApiApplicationsService,
  ExternalApiApplicationsServiceShape
>()("@dx/core/settings/applications/ExternalApiApplicationsService") {
  static readonly layer = Layer.effect(
    ExternalApiApplicationsService,
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      const repository = yield* ExternalApiApplicationRepository;
      const credentials = yield* ExternalApiApplicationCredentials;
      const settingsAudit = yield* SettingsAudit;

      const access = Effect.fn("ExternalApiApplicationsService.access")(
        function* (
          principal: Principal,
          workspaceSlug: WorkspaceShortName,
          permission: "applications:read" | "applications:manage",
        ) {
          const membership = (yield* settings.workspace(
            principal,
            workspaceSlug,
          )).workspace;
          if (
            membership.workspace.lifecycleState !== "active" ||
            !workspaceRoleHasPermission(membership.role, permission)
          ) {
            return yield* new WorkspacePermissionForbidden({ permission });
          }
          return membership;
        },
      );

      const audit = Effect.fn("ExternalApiApplicationsService.audit")(
        function* (input: AuditInput) {
          const auditId = yield* Schema.decodeUnknownEffect(
            ExternalApiApplicationAuditEventId,
          )(`eaa_${crypto.randomUUID()}`);
          yield* repository.recordAudit({
            id: auditId,
            applicationId: input.applicationId,
            workspaceId: input.workspaceId,
            actorType: "user",
            actorId: input.principal.userId,
            action: input.action,
            outcome: "success",
            requestId: input.requestId,
            createdAt: input.now,
          });
          yield* settingsAudit.record({
            action: input.action,
            scope: "workspace",
            outcome: "success",
            requestId: input.requestId,
            userId: input.principal.userId,
            workspaceId: input.workspaceId,
            targetApplicationId: input.applicationId,
            ...(input.scopes === undefined
              ? {}
              : { applicationScopes: input.scopes }),
          });
        },
      );

      return ExternalApiApplicationsService.of({
        list: Effect.fn("ExternalApiApplicationsService.list")(
          function* (principal, workspaceSlug, input) {
            const membership = yield* access(
              principal,
              workspaceSlug,
              "applications:read",
            );
            const page = yield* repository.list(membership.workspace.id, input);
            return {
              ...page,
              permissions: workspacePermissionsForRole(membership.role).filter(
                (permission) => permission.startsWith("applications:"),
              ),
            };
          },
        ),
        create: Effect.fn("ExternalApiApplicationsService.create")(
          function* (principal, workspaceSlug, input, requestId) {
            const membership = yield* access(
              principal,
              workspaceSlug,
              "applications:manage",
            );
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const id = yield* Schema.decodeUnknownEffect(
              ExternalApiApplicationId,
            )(`exa_${crypto.randomUUID()}`);
            const credentialId = yield* Schema.decodeUnknownEffect(
              ExternalApiApplicationCredentialId,
            )(`eac_${crypto.randomUUID()}`);
            const clientId = yield* credentials.createClientId();
            const secret = yield* credentials.createSecret();
            const application = yield* repository.create({
              id,
              workspaceId: membership.workspace.id,
              ownerUserId: principal.userId,
              clientId,
              name: input.name,
              scopes: input.scopes,
              rateLimitPerMinute: input.rateLimitPerMinute,
              credentialId,
              secretHash: secret.hash,
              credentialIdentifier: secret.identifier,
              now,
            });
            yield* audit({
              applicationId: id,
              workspaceId: membership.workspace.id,
              principal,
              action: "external_api_application.create",
              requestId,
              scopes: input.scopes,
              now,
            });
            return { application, clientSecret: secret.plaintext };
          },
        ),
        update: Effect.fn("ExternalApiApplicationsService.update")(
          function* (
            principal,
            workspaceSlug,
            applicationId,
            input,
            requestId,
          ) {
            const membership = yield* access(
              principal,
              workspaceSlug,
              "applications:manage",
            );
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const application = yield* repository.update(
              membership.workspace.id,
              applicationId,
              { ...input, now },
            );
            yield* audit({
              applicationId,
              workspaceId: membership.workspace.id,
              principal,
              action: "external_api_application.update",
              requestId,
              scopes: input.scopes,
              now,
            });
            return application;
          },
        ),
        rotate: Effect.fn("ExternalApiApplicationsService.rotate")(
          function* (
            principal,
            workspaceSlug,
            applicationId,
            overlapSeconds,
            requestId,
          ) {
            const membership = yield* access(
              principal,
              workspaceSlug,
              "applications:manage",
            );
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const credentialId = yield* Schema.decodeUnknownEffect(
              ExternalApiApplicationCredentialId,
            )(`eac_${crypto.randomUUID()}`);
            const secret = yield* credentials.createSecret();
            const application = yield* repository.rotateCredential(
              membership.workspace.id,
              applicationId,
              {
                credentialId,
                secretHash: secret.hash,
                credentialIdentifier: secret.identifier,
                now,
                previousExpiresAt: now + overlapSeconds * 1_000,
              },
            );
            yield* audit({
              applicationId,
              workspaceId: membership.workspace.id,
              principal,
              action: "external_api_application.rotate",
              requestId,
              now,
            });
            return { application, clientSecret: secret.plaintext };
          },
        ),
        setStatus: Effect.fn("ExternalApiApplicationsService.setStatus")(
          function* (
            principal,
            workspaceSlug,
            applicationId,
            status,
            requestId,
          ) {
            const membership = yield* access(
              principal,
              workspaceSlug,
              "applications:manage",
            );
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const application = yield* repository.setStatus(
              membership.workspace.id,
              applicationId,
              status,
              now,
            );
            yield* audit({
              applicationId,
              workspaceId: membership.workspace.id,
              principal,
              action: `external_api_application.${
                status === "active"
                  ? "enable"
                  : status === "disabled"
                    ? "disable"
                    : "revoke"
              }`,
              requestId,
              now,
            });
            return application;
          },
        ),
        listAudit: Effect.fn("ExternalApiApplicationsService.listAudit")(
          function* (principal, workspaceSlug, applicationId, input) {
            const membership = yield* access(
              principal,
              workspaceSlug,
              "applications:read",
            );
            return yield* repository.listAudit(
              membership.workspace.id,
              applicationId,
              input,
            );
          },
        ),
      });
    }),
  );
}
