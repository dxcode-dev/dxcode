import {
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  SourceControlAccessDenied,
  SourceControlLeaseFailure,
} from "@dx/domain";
import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { SourceAudit, type SourceAuditRecord } from "./audit.js";
import {
  GitHubRuntimeAdapter,
  githubCommandEnvironment,
  githubInstallationHasApprovedEnvelope,
  githubPermissionsForOperation,
  githubPermissionsForOperations,
} from "./github/runtime-adapter.js";
import {
  NATIVE_GITHUB_CREDENTIAL_CAPABILITIES,
  SourceAuthorizationPolicy,
  SourceAuthorizationPolicyLive,
  SourceRuntimeBroker,
  SourceRuntimeBrokerLive,
} from "./runtime.js";
import {
  type RuntimeSourceAuthority,
  SourceAuthorityRepository,
} from "./runtime-authority.js";

const authority: RuntimeSourceAuthority = {
  threadId: "thread-115",
  projectId: "project-115",
  actorUserId: "user-115",
  provider: "github",
  ownerScope: "personal",
  ownerId: "user-115",
  grantId: "grant-115",
  installationId: "9115",
  providerAccountId: "8115",
  providerRepositoryId: "7115",
  repositoryName: "owner/repository",
  rootProviderRepositoryId: "7115",
  bindingRevision: 1,
  authorizationEpoch: 1,
  installationEpoch: 1,
  policyRevision: 0,
  defaultBranch: "main",
  shipAction: "ship",
  repositorySelection: "selected",
  fingerprint: "stable-authority",
};

const cases = [
  ["checkout", { contents: "read", metadata: "read" }],
  ["fetch", { contents: "read", metadata: "read" }],
  ["provider-auth-read", { metadata: "read" }],
  ["repository-read", { contents: "read", metadata: "read" }],
  ["contents-push", { contents: "write", metadata: "read" }],
  ["pull-request-read", { metadata: "read", pull_requests: "read" }],
  ["pull-request-write", { metadata: "read", pull_requests: "write" }],
  ["issue-read", { issues: "read", metadata: "read" }],
  ["issue-write", { issues: "write", metadata: "read" }],
  ["actions-read", { actions: "read", metadata: "read" }],
  ["actions-write", { actions: "write", metadata: "read" }],
  [
    "workflow-write",
    { contents: "write", metadata: "read", workflows: "write" },
  ],
  [
    "checks-status-read",
    {
      checks: "read",
      metadata: "read",
      pull_requests: "read",
      statuses: "read",
    },
  ],
] as const;

const policyLayer = SourceAuthorizationPolicyLive;

describe("SourceAuthorizationPolicy", () => {
  it("requires the approved broad installation envelope before narrowing a lease", () => {
    const approved = {
      actions: "write",
      checks: "read",
      contents: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
      statuses: "read",
      workflows: "write",
      organization_projects: "write",
    } as const;
    expect(
      githubInstallationHasApprovedEnvelope(approved, "Organization"),
    ).toBe(true);
    expect(
      githubInstallationHasApprovedEnvelope(
        { ...approved, issues: "read" },
        "Organization",
      ),
    ).toBe(false);
    expect(
      githubInstallationHasApprovedEnvelope(
        {
          ...approved,
          administration: "read",
        },
        "Organization",
      ),
    ).toBe(false);

    const { organization_projects: _, ...personalApproved } = approved;
    expect(
      githubInstallationHasApprovedEnvelope(personalApproved, "User"),
    ).toBe(true);
    expect(githubInstallationHasApprovedEnvelope(approved, "User")).toBe(false);
  });

  it.each(cases)(
    "maps %s to only its minimum permission subset",
    async (operation, expected) => {
      const decision = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceAuthorizationPolicy).authorize(
            authority,
            {
              operation,
              invocationSource: "agent-command",
              ...(["contents-push", "workflow-write"].includes(operation)
                ? { targetBranch: "feature/115" }
                : {}),
            },
          );
        }).pipe(Effect.provide(policyLayer)),
      );
      expect(decision.requestedCapabilities).toEqual([operation]);
      const permissions = githubPermissionsForOperation(operation);
      expect(permissions).toEqual(expected);
      expect(Object.keys(permissions).sort()).toEqual(
        Object.keys(expected).sort(),
      );
    },
  );

  it("leaves native Git ref and default-branch decisions to the provider", async () => {
    const authorize = (targetBranch: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceAuthorizationPolicy).authorize(
            { ...authority, shipAction: "commit" },
            {
              operation: "contents-push",
              invocationSource: "agent-command",
              targetBranch,
            },
          );
        }).pipe(Effect.provide(policyLayer)),
      );
    await expect(authorize("main")).resolves.toMatchObject({
      access: "write",
      requestedCapabilities: ["contents-push"],
    });
    await expect(authorize("bad..branch")).resolves.toMatchObject({
      access: "write",
      requestedCapabilities: ["contents-push"],
    });
  });
});

const brokerLayer = (input?: {
  readonly authorities?: ReadonlyArray<RuntimeSourceAuthority>;
  readonly revokeFailure?: boolean;
  readonly records?: Array<SourceAuditRecord>;
  readonly acquire?: (permissions: unknown) => void;
  readonly revoke?: () => void;
  readonly resolveFailure?: SourceControlAccessDenied;
  readonly auditFailure?: boolean;
}) => {
  let reads = 0;
  const records = input?.records ?? [];
  const acquire = input?.acquire ?? vi.fn();
  const revoke = input?.revoke ?? vi.fn();
  const dependencies = Layer.mergeAll(
    policyLayer,
    Layer.succeed(
      SourceAuthorityRepository,
      SourceAuthorityRepository.of({
        resolve: () =>
          input?.resolveFailure !== undefined
            ? Effect.fail(input.resolveFailure)
            : Effect.succeed(
                input?.authorities?.[reads++] ??
                  input?.authorities?.at(-1) ??
                  authority,
              ),
      }),
    ),
    Layer.succeed(
      GitHubRuntimeAdapter,
      GitHubRuntimeAdapter.of({
        acquire: (_authority, operation, lifecycle) => {
          acquire(operation);
          lifecycle?.issued();
          return Effect.succeed({
            environment: githubCommandEnvironment(
              "synthetic-secret-115",
              "owner/repository",
            ),
            expiresAt: new Date("2026-08-25T13:00:00.000Z"),
            revoke: Effect.sync(revoke).pipe(
              Effect.andThen(
                input?.revokeFailure
                  ? Effect.fail(
                      new SourceControlLeaseFailure({
                        reason: "token-revoke-failed",
                        retryable: false,
                      }),
                    )
                  : Effect.void,
              ),
            ),
          });
        },
      }),
    ),
    Layer.succeed(
      SourceAudit,
      SourceAudit.of({
        record: (record) =>
          input?.auditFailure
            ? Effect.fail(
                new SourceControlLeaseFailure({
                  reason: "audit-unavailable",
                  retryable: true,
                }),
              )
            : Effect.sync(() => {
                records.push(record);
              }),
      }),
    ),
  );
  return SourceRuntimeBrokerLive({
    clock: () => new Date("2026-08-25T12:00:00.000Z"),
  }).pipe(Layer.provide(dependencies));
};

describe("SourceRuntimeBroker", () => {
  it("audits a pre-mint authority denial without acquiring a credential", async () => {
    const records: SourceAuditRecord[] = [];
    const acquire = vi.fn();
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
            authority.threadId,
            authority.actorUserId,
            { operation: "fetch", invocationSource: "agent-command" },
            () => Effect.void,
          );
        }).pipe(
          Effect.provide(
            brokerLayer({
              records,
              acquire,
              resolveFailure: new SourceControlAccessDenied({
                reason: "grant-disconnected",
                action: "reconnect",
              }),
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ reason: "grant-disconnected" });
    expect(acquire).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      outcome: "denied",
      reason: "grant-disconnected",
      credentialClass: "none",
    });
  });

  it("keeps the credential callback-scoped, rechecks authority, revokes, and audits success", async () => {
    const records: SourceAuditRecord[] = [];
    const acquire = vi.fn();
    const revoke = vi.fn();
    const callback = vi.fn((environment: Readonly<Record<string, string>>) =>
      Effect.succeed({
        keys: Object.keys(environment).sort(),
        tokenValues: Object.values(environment).filter(
          (value) => value === "synthetic-secret-115",
        ),
      }),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
          authority.threadId,
          authority.actorUserId,
          { operation: "issue-write", invocationSource: "agent-command" },
          callback,
        );
      }).pipe(Effect.provide(brokerLayer({ records, acquire, revoke }))),
    );
    expect(result.keys).toEqual(
      Object.keys(
        githubCommandEnvironment("synthetic-secret-115", "owner/repository"),
      ).sort(),
    );
    expect(result.tokenValues).toEqual(["synthetic-secret-115"]);
    expect(acquire).toHaveBeenCalledWith(["issue-write"]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "success",
      credentialClass: "github-app-installation",
      providerRepositoryId: "7115",
      requestedCapabilities: ["issue-write"],
    });
    expect(JSON.stringify(records)).not.toContain("synthetic-secret-115");
  });

  it("revokes and denies post-mint authority drift before invoking the callback", async () => {
    const records: SourceAuditRecord[] = [];
    const revoke = vi.fn();
    const callback = vi.fn(() => Effect.void);
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
            authority.threadId,
            authority.actorUserId,
            { operation: "fetch", invocationSource: "agent-command" },
            callback,
          );
        }).pipe(
          Effect.provide(
            brokerLayer({
              records,
              revoke,
              authorities: [
                authority,
                { ...authority, fingerprint: "disconnected-during-mint" },
              ],
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ reason: "provider-authority-changed" });
    expect(callback).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({
      outcome: "denied",
      reason: "provider-authority-changed",
    });
  });

  it("preserves callback failure and records a best-effort revoke failure", async () => {
    const records: SourceAuditRecord[] = [];
    const callbackFailure = new Error("bounded callback failure");
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
            authority.threadId,
            authority.actorUserId,
            { operation: "fetch", invocationSource: "setup-hook" },
            () => Effect.fail(callbackFailure),
          );
        }).pipe(Effect.provide(brokerLayer({ records, revokeFailure: true }))),
      ),
    ).rejects.toBe(callbackFailure);
    expect(records[0]).toMatchObject({
      outcome: "callback-failed",
      reason: "callback-failed+token-revoke-failed",
    });
  });

  const nativeCredential = (layer: ReturnType<typeof brokerLayer>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
          authority.threadId,
          authority.actorUserId,
          { operation: "workflow-write", invocationSource: "git-helper" },
          (environment) => Effect.succeed(environment.GH_TOKEN),
        );
      }).pipe(Effect.provide(layer)),
    );

  it("issues one native credential with the complete repository envelope", async () => {
    const records: SourceAuditRecord[] = [];
    const acquire = vi.fn();
    const revoke = vi.fn();
    await expect(
      nativeCredential(brokerLayer({ records, acquire, revoke })),
    ).resolves.toBe("synthetic-secret-115");
    expect(acquire).toHaveBeenCalledWith(NATIVE_GITHUB_CREDENTIAL_CAPABILITIES);
    expect(
      githubPermissionsForOperations(NATIVE_GITHUB_CREDENTIAL_CAPABILITIES),
    ).toEqual(GITHUB_APP_REPOSITORY_PERMISSIONS);
    expect(revoke).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      invocationSource: "git-helper",
      outcome: "success",
      requestedCapabilities: NATIVE_GITHUB_CREDENTIAL_CAPABILITIES,
    });
  });

  it("revokes a native credential when its audit cannot be recorded", async () => {
    const revoke = vi.fn();
    await expect(
      nativeCredential(brokerLayer({ revoke, auditFailure: true })),
    ).rejects.toMatchObject({ reason: "audit-unavailable" });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes a native credential after post-mint authority drift", async () => {
    const revoke = vi.fn();
    await expect(
      nativeCredential(
        brokerLayer({
          revoke,
          authorities: [
            authority,
            { ...authority, fingerprint: "disconnected-during-mint" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ reason: "provider-authority-changed" });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("revokes and audits interruption without claiming provider cancellation", async () => {
    const records: SourceAuditRecord[] = [];
    const revoke = vi.fn();
    const effect = Effect.gen(function* () {
      return yield* (yield* SourceRuntimeBroker).withCommandEnvironment(
        authority.threadId,
        authority.actorUserId,
        { operation: "fetch", invocationSource: "resume-hook" },
        () => Effect.never,
      );
    }).pipe(Effect.provide(brokerLayer({ records, revoke })));
    const fiber = Effect.runFork(effect);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(revoke).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({
      outcome: "interrupted",
      reason: "interrupted",
    });
  });
});
