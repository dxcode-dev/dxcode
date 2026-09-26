import { env } from "cloudflare:test";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { SourceAuditD1 } from "../../src/source-control/audit.js";
import {
  GitHubRuntimeAdapter,
  githubCommandEnvironment,
} from "../../src/source-control/github/runtime-adapter.js";
import {
  SourceAuthorizationPolicyLive,
  SourceRuntimeBroker,
  SourceRuntimeBrokerLive,
} from "../../src/source-control/runtime.js";
import {
  type RuntimeSourceAuthority,
  SourceAuthorityRepository,
} from "../../src/source-control/runtime-authority.js";

const authority: RuntimeSourceAuthority = {
  threadId: "thread-117",
  projectId: "project-117",
  actorUserId: "user-117",
  provider: "github",
  ownerScope: "personal",
  ownerId: "user-117",
  grantId: "grant-117",
  installationId: "9117",
  providerAccountId: "8117",
  providerRepositoryId: "7117",
  repositoryName: "owner/repository",
  rootProviderRepositoryId: "7117",
  bindingRevision: 1,
  authorizationEpoch: 1,
  installationEpoch: 1,
  policyRevision: 0,
  defaultBranch: "main",
  shipAction: "ship",
  repositorySelection: "selected",
  fingerprint: "stable-authority-117",
};

const brokerLayer = () => {
  const deps = Layer.mergeAll(
    SourceAuthorizationPolicyLive,
    Layer.succeed(
      SourceAuthorityRepository,
      SourceAuthorityRepository.of({
        resolve: () => Effect.succeed(authority),
      }),
    ),
    Layer.succeed(
      GitHubRuntimeAdapter,
      GitHubRuntimeAdapter.of({
        acquire: (_authority, _operation, lifecycle) => {
          lifecycle?.issued();
          return Effect.succeed({
            environment: githubCommandEnvironment(
              "synthetic-secret-117",
              "owner/repository",
            ),
            expiresAt: new Date("2026-09-03T13:00:00.000Z"),
            revoke: Effect.void,
          });
        },
      }),
    ),
    SourceAuditD1(env.DB),
  );
  return SourceRuntimeBrokerLive({
    clock: () => new Date("2026-09-03T12:00:00.000Z"),
  }).pipe(Layer.provide(deps));
};

describe("SourceRuntimeBroker against real D1 audit", () => {
  it("audits a provider-auth-read lease without an audit-unavailable failure", async () => {
    const callback = vi.fn((environment: Readonly<Record<string, string>>) =>
      Effect.succeed({ leaseKeys: Object.keys(environment).length }),
    );
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM source_control_operation_audit WHERE requested_capabilities_json = ?",
    )
      .bind('["provider-auth-read"]')
      .first<Record<string, number>>();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
          authority.threadId,
          authority.actorUserId,
          {
            operation: "provider-auth-read",
            invocationSource: "agent-command",
          },
          callback,
        );
      }).pipe(Effect.provide(brokerLayer())),
    );

    expect(callback).toHaveBeenCalledOnce();
    expect(result.leaseKeys).toBeGreaterThan(0);

    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM source_control_operation_audit WHERE requested_capabilities_json = ?",
    )
      .bind('["provider-auth-read"]')
      .first<Record<string, number>>();
    const inserted = await env.DB.prepare(
      "SELECT requested_capabilities_json, outcome, credential_class, invocation_source FROM source_control_operation_audit WHERE requested_capabilities_json = ? ORDER BY occurred_at DESC LIMIT 1",
    )
      .bind('["provider-auth-read"]')
      .first<Record<string, unknown>>();
    expect((after?.total ?? 0) - (before?.total ?? 0)).toBe(1);
    expect(inserted).toMatchObject({
      requested_capabilities_json: '["provider-auth-read"]',
      outcome: "success",
      credential_class: "github-app-installation",
      invocation_source: "agent-command",
    });
  });
});
