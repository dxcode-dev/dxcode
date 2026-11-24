import {
  ExternalApiApplicationAuditEventId,
  ExternalApiApplicationClientId,
  ExternalApiApplicationClientSecret,
  type ExternalApiApplicationCredentialId,
  ExternalApiApplicationRateLimited,
  ExternalApiApplicationRepository,
  type ExternalApiApplicationScope,
  type Principal,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { applicationAuditLogger } from "../logging.js";
import { ExternalApiApplicationCredentials } from "../settings/applications/credentials.js";
import { ExternalApiApplicationRepositoryD1 } from "../settings/applications/repository-d1.js";

const layerFor = (db: D1Database) =>
  Layer.merge(
    ExternalApiApplicationRepositoryD1(db),
    ExternalApiApplicationCredentials.layer,
  );

export interface ExternalApplicationBasicCredentials {
  readonly clientId: typeof ExternalApiApplicationClientId.Type;
  readonly clientSecret: typeof ExternalApiApplicationClientSecret.Type;
}

export const decodeExternalApplicationBasicCredentials = (
  authorization: string,
): ExternalApplicationBasicCredentials | undefined => {
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(authorization)?.[1];
  if (encoded === undefined) return undefined;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator < 1 || decoded.indexOf(":", separator + 1) !== -1) {
    return undefined;
  }
  const clientId = Schema.decodeUnknownOption(ExternalApiApplicationClientId)(
    decoded.slice(0, separator),
  );
  const clientSecret = Schema.decodeUnknownOption(
    ExternalApiApplicationClientSecret,
  )(decoded.slice(separator + 1));
  return Option.isSome(clientId) && Option.isSome(clientSecret)
    ? { clientId: clientId.value, clientSecret: clientSecret.value }
    : undefined;
};

export const authenticateExternalApiApplication = (
  db: D1Database,
  input: ExternalApplicationBasicCredentials & {
    readonly requestId: string;
    readonly method: string;
    readonly path: string;
  },
) =>
  Effect.gen(function* () {
    const repository = yield* ExternalApiApplicationRepository;
    const credentials = yield* ExternalApiApplicationCredentials;
    const now = Date.now();
    // The budget is claimed before the secret is checked, so wrong secrets
    // against a known client id are throttled and audited like any request.
    const known = yield* repository.findActiveByClientId(input.clientId);
    if (Option.isNone(known)) return Option.none<Principal>();
    const windowStartedAt = Math.floor(now / 60_000) * 60_000;
    const claimed = yield* repository.claimRateLimit(
      known.value.applicationId,
      known.value.rateLimitPerMinute,
      windowStartedAt,
    );
    const secretHash = yield* credentials.hash(input.clientSecret);
    const authenticated = yield* repository.authenticate(
      input.clientId,
      secretHash,
      now,
    );
    const rejected = (
      credentialId?: typeof ExternalApiApplicationCredentialId.Type,
    ) =>
      Effect.gen(function* () {
        yield* repository.recordAudit({
          id: yield* Schema.decodeUnknownEffect(
            ExternalApiApplicationAuditEventId,
          )(`eaa_${crypto.randomUUID()}`),
          applicationId: known.value.applicationId,
          workspaceId: known.value.workspaceId,
          actorType: "application",
          actorId: known.value.applicationId,
          action: "external_api_application.request",
          outcome: "rejected",
          requestId: input.requestId,
          ...(credentialId === undefined ? {} : { credentialId }),
          method: input.method,
          path: input.path,
          createdAt: now,
        });
      });
    const rateLimited = new ExternalApiApplicationRateLimited({
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowStartedAt + 60_000 - now) / 1_000),
      ),
    });
    if (Option.isNone(authenticated)) {
      // Past the budget, a wrong secret writes no row: the audit stays
      // bounded by the application's own rate limit.
      if (!claimed) return yield* rateLimited;
      yield* rejected();
      return Option.none<Principal>();
    }
    const application = authenticated.value;
    if (!claimed) {
      yield* rejected(application.credentialId);
      return yield* rateLimited;
    }
    yield* repository.touchLastUsed(application.applicationId, now);
    return Option.some<Principal>({
      userId: application.ownerUserId,
      credentialScopes: ["workspace"],
      apiTokenScopes: application.scopes,
      application: {
        id: application.applicationId,
        workspaceId: application.workspaceId,
        clientId: application.clientId,
        credentialId: application.credentialId,
      },
    });
  }).pipe(Effect.provide(layerFor(db)));

export const auditExternalApiApplicationRequest = (
  db: D1Database,
  input: {
    readonly principal: Principal;
    readonly requestId: string;
    readonly method: string;
    readonly path: string;
    readonly scope?: ExternalApiApplicationScope;
    readonly outcome: "authorized" | "rejected";
  },
) => {
  const application = input.principal.application;
  if (application === undefined) return Effect.void;
  return Effect.gen(function* () {
    const repository = yield* ExternalApiApplicationRepository;
    yield* repository.recordAudit({
      id: yield* Schema.decodeUnknownEffect(ExternalApiApplicationAuditEventId)(
        `eaa_${crypto.randomUUID()}`,
      ),
      applicationId: application.id,
      workspaceId: application.workspaceId,
      actorType: "application",
      actorId: application.id,
      action: "external_api_application.request",
      outcome: input.outcome,
      requestId: input.requestId,
      credentialId: application.credentialId,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      method: input.method,
      path: input.path,
      createdAt: Date.now(),
    });
    yield* Effect.sync(() =>
      applicationAuditLogger.info("External API application request audited.", {
        event: "external_api_application_request_audited",
        applicationId: application.id,
        workspaceId: application.workspaceId,
        credentialId: application.credentialId,
        ownerUserId: input.principal.userId,
        requestId: input.requestId,
        method: input.method,
        path: input.path,
        scope: input.scope ?? "unmapped",
        outcome: input.outcome,
      }),
    );
  }).pipe(Effect.provide(ExternalApiApplicationRepositoryD1(db)));
};
