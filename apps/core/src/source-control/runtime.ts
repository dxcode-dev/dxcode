import {
  PersistenceUnavailable,
  SourceControlAccessDenied,
  SourceControlLeaseFailure,
  SourceControlProviderFailure,
  SourceOperationRequest,
  type SourceOperationRequestType,
  type SourceOperationType,
} from "@dx/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { sourceControlLogger } from "../logging.js";
import { SourceAudit } from "./audit.js";
import { sourceAccessDenied } from "./authority.js";
import { GitHubRuntimeAdapter } from "./github/runtime-adapter.js";
import { sourceControlProviderRegistry } from "./provider-registry.js";
import {
  type RuntimeSourceAuthority,
  SourceAuthorityRepository,
} from "./runtime-authority.js";

export interface SourcePolicyDecision {
  readonly access: "read" | "write";
  readonly requestedCapabilities: ReadonlyArray<SourceOperationType>;
}

export interface SourceAuthorizationPolicyShape {
  readonly authorize: (
    authority: RuntimeSourceAuthority,
    request: SourceOperationRequestType,
  ) => Effect.Effect<SourcePolicyDecision, SourceControlAccessDenied>;
}

export class SourceAuthorizationPolicy extends Context.Service<
  SourceAuthorizationPolicy,
  SourceAuthorizationPolicyShape
>()("@dx/core/source-control/SourceAuthorizationPolicy") {}

const writeOperations = new Set<SourceOperationRequestType["operation"]>([
  "contents-push",
  "pull-request-write",
  "issue-write",
  "actions-write",
  "workflow-write",
]);

export const SourceAuthorizationPolicyLive = Layer.effect(
  SourceAuthorizationPolicy,
  Effect.gen(function* () {
    return SourceAuthorizationPolicy.of({
      authorize: (authority, request) =>
        Effect.gen(function* () {
          const access = writeOperations.has(request.operation)
            ? "write"
            : "read";
          const descriptor = sourceControlProviderRegistry.descriptorFor(
            authority.provider,
          );
          const requiredCapability =
            access === "write" ? "runtime-write" : "runtime-read";
          if (
            descriptor?.availability !== "enabled" ||
            !descriptor.capabilities.includes(requiredCapability)
          )
            return yield* sourceAccessDenied(
              "unsupported-capability",
              "reconfigure",
            );
          return {
            access,
            requestedCapabilities: [request.operation],
          };
        }),
    });
  }),
);

type RuntimeFailure =
  | SourceControlAccessDenied
  | SourceControlProviderFailure
  | SourceControlLeaseFailure
  | PersistenceUnavailable
  | Schema.SchemaError;

export interface SourceRuntimeBrokerShape {
  readonly withCommandEnvironment: <A, E, R>(
    threadId: string,
    actorUserId: string,
    request: SourceOperationRequestType,
    callback: (
      environment: Readonly<Record<string, string>>,
    ) => Effect.Effect<A, E, R>,
    targetProviderRepositoryId?: string,
  ) => Effect.Effect<A, E | RuntimeFailure, R>;
}

export class SourceRuntimeBroker extends Context.Service<
  SourceRuntimeBroker,
  SourceRuntimeBrokerShape
>()("@dx/core/source-control/SourceRuntimeBroker") {}

export const SourceRuntimeBrokerLive = (input?: {
  readonly clock?: () => Date;
}) =>
  Layer.effect(
    SourceRuntimeBroker,
    Effect.gen(function* () {
      const authorities = yield* SourceAuthorityRepository;
      const policy = yield* SourceAuthorizationPolicy;
      const github = yield* GitHubRuntimeAdapter;
      const audit = yield* SourceAudit;
      const clock = input?.clock ?? (() => new Date());
      return SourceRuntimeBroker.of({
        withCommandEnvironment: (
          threadId,
          actorUserId,
          unsafeRequest,
          callback,
          targetProviderRepositoryId,
        ) =>
          Effect.suspend(() => {
            const operationId = `sco_${crypto.randomUUID()}`;
            const startedAt = clock();
            let authority: RuntimeSourceAuthority | undefined;
            let decision: SourcePolicyDecision | undefined;
            let credentialIssued = false;
            let revokeFailed = false;
            let outcome:
              | "success"
              | "denied"
              | "provider-failed"
              | "callback-failed"
              | "interrupted" = "denied";
            let reason: string | undefined;
            const operation = Effect.gen(function* () {
              const request = yield* Schema.decodeUnknownEffect(
                SourceOperationRequest,
              )(unsafeRequest);
              authority = yield* authorities.resolve(
                threadId,
                actorUserId,
                request,
                targetProviderRepositoryId,
              );
              decision = yield* policy.authorize(authority, request);
              const initialAuthority = authority;
              return yield* Effect.acquireUseRelease(
                github.acquire(authority, request.operation, {
                  issued: () => {
                    credentialIssued = true;
                  },
                  revokeFailed: () => {
                    revokeFailed = true;
                  },
                }),
                (credential) =>
                  Effect.gen(function* () {
                    const after = yield* authorities.resolve(
                      threadId,
                      actorUserId,
                      request,
                      targetProviderRepositoryId,
                    );
                    if (after.fingerprint !== initialAuthority.fingerprint)
                      return yield* new SourceControlLeaseFailure({
                        reason: "provider-authority-changed",
                        retryable: true,
                      });
                    yield* policy.authorize(after, request);
                    return yield* callback(credential.environment).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          outcome = "success";
                        }),
                      ),
                      Effect.tapError(() =>
                        Effect.sync(() => {
                          outcome = "callback-failed";
                          reason = "callback-failed";
                        }),
                      ),
                    );
                  }),
                (credential) =>
                  request.invocationSource === "git-helper"
                    ? Effect.void
                    : credential.revoke.pipe(
                        Effect.catch(() =>
                          Effect.sync(() => {
                            revokeFailed = true;
                          }),
                        ),
                      ),
              );
            }).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (outcome === "callback-failed") return;
                  outcome =
                    error instanceof SourceControlProviderFailure
                      ? "provider-failed"
                      : "denied";
                  reason =
                    error instanceof SourceControlAccessDenied
                      ? error.reason
                      : error instanceof SourceControlLeaseFailure
                        ? error.reason
                        : error instanceof SourceControlProviderFailure
                          ? "provider-failed"
                          : error instanceof PersistenceUnavailable
                            ? "authority-unavailable"
                            : "invalid-operation";
                }),
              ),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  outcome = "interrupted";
                  reason = "interrupted";
                }),
              ),
            );
            return operation.pipe(
              Effect.onExit(() => {
                const completedAt = clock();
                if (revokeFailed)
                  reason =
                    reason === undefined
                      ? "token-revoke-failed"
                      : `${reason}+token-revoke-failed`;
                const record = {
                  operationId,
                  occurredAt: startedAt.toISOString(),
                  actorUserId,
                  ...(authority === undefined
                    ? {}
                    : {
                        projectId: authority.projectId,
                        provider: authority.provider,
                        providerRepositoryId: authority.providerRepositoryId,
                      }),
                  threadId,
                  requestedCapabilities: decision?.requestedCapabilities ?? [
                    unsafeRequest.operation,
                  ],
                  credentialClass: credentialIssued
                    ? ("github-app-installation" as const)
                    : ("none" as const),
                  invocationSource: unsafeRequest.invocationSource,
                  outcome,
                  ...(reason === undefined ? {} : { reason }),
                  durationMs: Math.max(
                    0,
                    completedAt.getTime() - startedAt.getTime(),
                  ),
                };
                sourceControlLogger.info("Source-control operation settled.", {
                  operationId,
                  actorUserId,
                  projectId: record.projectId,
                  threadId,
                  provider: record.provider,
                  providerRepositoryId: record.providerRepositoryId,
                  requestedCapabilities: record.requestedCapabilities,
                  credentialClass: record.credentialClass,
                  invocationSource: record.invocationSource,
                  outcome,
                  reason,
                  durationMs: record.durationMs,
                });
                return audit.record(record);
              }),
            );
          }),
      });
    }),
  );
