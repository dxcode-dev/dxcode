import { SourceControlAccessDenied } from "@dx/domain";
import { Effect, Redacted } from "effect";
import { describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
  createGitHubAppJwt: vi.fn(),
  createGitHubProvider: vi.fn(),
  loadGitHubAppConfiguration: vi.fn(),
}));

vi.mock("./github/app-auth.js", () => ({
  createGitHubAppJwt: github.createGitHubAppJwt,
}));
vi.mock("./github/configuration.js", () => ({
  loadGitHubAppConfiguration: github.loadGitHubAppConfiguration,
}));
vi.mock("./github/provider-http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github/provider-http.js")>()),
  createGitHubProvider: github.createGitHubProvider,
}));

import { authorizeProjectSource, authorizeSource } from "./admission.js";

const authority = {
  installation_id: "9",
  grant_status: "active",
  installation_status: "active",
  entitled: 1,
  grant_epoch: 1,
  installation_epoch: 1,
  policy_revision: 0,
};

const db = {
  prepare: () => ({
    bind: () => ({ first: async () => authority }),
  }),
} as unknown as D1Database;

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const installation = {
  id: "9",
  account: { id: "19", login: "owner", type: "User" as const },
  repositorySelection: "selected" as const,
  permissions: { contents: "write" as const, metadata: "read" as const },
};

const lease = {
  token: "short-lived-token",
  expiresAt: new Date("2026-08-28T13:00:00.000Z"),
};

const resolved = {
  repository: {
    id: "42",
    fullName: "owner/repository",
    webUrl: "https://github.com/owner/repository",
    cloneUrl: "https://github.com/owner/repository.git",
    visibility: "private" as const,
    archived: false,
    defaultBranch: "main",
  },
  commitSha: "a".repeat(40),
};

const authorize = (waitUntil?: (promise: Promise<unknown>) => void) =>
  authorizeSource({
    db,
    bindings: {} as never,
    owner: { scope: "personal", id: "user-233" },
    grantId: "grant-233",
    repositoryId: "42",
    waitUntil,
  });

describe("source admission provider freshness", () => {
  it("validates the installation and mints the restricted token concurrently", async () => {
    const installationResult = deferred<typeof installation>();
    const leaseResult = deferred<typeof lease>();
    const provider = {
      getInstallation: vi.fn(() => installationResult.promise),
      createInstallationToken: vi.fn(() => leaseResult.promise),
      resolveRepositorySource: vi.fn(async () => resolved),
      revokeInstallationToken: vi.fn(async () => undefined),
    };
    github.loadGitHubAppConfiguration.mockReturnValue(
      Effect.succeed({
        appId: "1",
        privateKeyPem: Redacted.make("private-key"),
      }),
    );
    github.createGitHubAppJwt.mockResolvedValue("app-jwt");
    github.createGitHubProvider.mockReturnValue(provider);

    const authorization = authorize();
    await vi.waitFor(() => {
      expect(provider.getInstallation).toHaveBeenCalledOnce();
      expect(provider.createInstallationToken).toHaveBeenCalledOnce();
    });
    installationResult.resolve(installation);
    leaseResult.resolve(lease);

    await expect(authorization).resolves.toMatchObject({
      installationId: "9",
      providerRepositoryId: "42",
    });
    expect(provider.revokeInstallationToken).toHaveBeenCalledWith(lease.token);
  });

  it("revokes a minted token when concurrent installation validation fails", async () => {
    const leaseResult = deferred<typeof lease>();
    const provider = {
      getInstallation: vi.fn(async () => {
        throw new SourceControlAccessDenied({
          reason: "installation-suspended",
          action: "reconfigure",
        });
      }),
      createInstallationToken: vi.fn(() => leaseResult.promise),
      resolveRepositorySource: vi.fn(async () => resolved),
      revokeInstallationToken: vi.fn(async () => undefined),
    };
    github.loadGitHubAppConfiguration.mockReturnValue(
      Effect.succeed({
        appId: "1",
        privateKeyPem: Redacted.make("private-key"),
      }),
    );
    github.createGitHubAppJwt.mockResolvedValue("app-jwt");
    github.createGitHubProvider.mockReturnValue(provider);

    const authorization = authorize();
    await vi.waitFor(() =>
      expect(provider.createInstallationToken).toHaveBeenCalledOnce(),
    );
    leaseResult.resolve(lease);

    await expect(authorization).rejects.toMatchObject({
      reason: "installation-suspended",
    });
    expect(provider.revokeInstallationToken).toHaveBeenCalledWith(lease.token);
    expect(provider.resolveRepositorySource).not.toHaveBeenCalled();
  });

  it("returns an installation denial when token issuance never settles", async () => {
    vi.useFakeTimers();
    try {
      const leaseResult = deferred<typeof lease>();
      const provider = {
        getInstallation: vi.fn(async () => {
          throw new SourceControlAccessDenied({
            reason: "installation-suspended",
            action: "reconfigure",
          });
        }),
        createInstallationToken: vi.fn(() => leaseResult.promise),
        resolveRepositorySource: vi.fn(async () => resolved),
        revokeInstallationToken: vi.fn(async () => undefined),
      };
      github.loadGitHubAppConfiguration.mockReturnValue(
        Effect.succeed({
          appId: "1",
          privateKeyPem: Redacted.make("private-key"),
        }),
      );
      github.createGitHubAppJwt.mockResolvedValue("app-jwt");
      github.createGitHubProvider.mockReturnValue(provider);

      const authorization = authorize().then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      );
      await vi.waitFor(() =>
        expect(provider.createInstallationToken).toHaveBeenCalledOnce(),
      );

      const outcome = Promise.race([
        authorization,
        new Promise<"timed-out">((resolve) =>
          setTimeout(() => resolve("timed-out"), 2_000),
        ),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(outcome).resolves.toBe("rejected");

      leaseResult.resolve(lease);
      await vi.waitFor(() =>
        expect(provider.revokeInstallationToken).toHaveBeenCalledWith(
          lease.token,
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers late denial cleanup with the Worker lifetime", async () => {
    vi.useFakeTimers();
    try {
      const leaseResult = deferred<typeof lease>();
      const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
      const provider = {
        getInstallation: vi.fn(async () => {
          throw new SourceControlAccessDenied({
            reason: "installation-suspended",
            action: "reconfigure",
          });
        }),
        createInstallationToken: vi.fn(() => leaseResult.promise),
        resolveRepositorySource: vi.fn(async () => resolved),
        revokeInstallationToken: vi.fn(async () => undefined),
      };
      github.loadGitHubAppConfiguration.mockReturnValue(
        Effect.succeed({
          appId: "1",
          privateKeyPem: Redacted.make("private-key"),
        }),
      );
      github.createGitHubAppJwt.mockResolvedValue("app-jwt");
      github.createGitHubProvider.mockReturnValue(provider);

      const authorization = authorize(waitUntil).catch((cause) => cause);
      await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledOnce());
      const registeredCleanup = waitUntil.mock.calls[0]?.[0];

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(authorization).resolves.toBeInstanceOf(
        SourceControlAccessDenied,
      );
      expect(provider.revokeInstallationToken).not.toHaveBeenCalled();

      leaseResult.resolve(lease);
      await registeredCleanup;
      expect(provider.revokeInstallationToken).toHaveBeenCalledWith(
        lease.token,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold an installation denial on a hanging token revocation", async () => {
    vi.useFakeTimers();
    try {
      const revocation = deferred<void>();
      const provider = {
        getInstallation: vi.fn(async () => {
          throw new SourceControlAccessDenied({
            reason: "installation-suspended",
            action: "reconfigure",
          });
        }),
        createInstallationToken: vi.fn(async () => lease),
        resolveRepositorySource: vi.fn(async () => resolved),
        revokeInstallationToken: vi.fn(() => revocation.promise),
      };
      github.loadGitHubAppConfiguration.mockReturnValue(
        Effect.succeed({
          appId: "1",
          privateKeyPem: Redacted.make("private-key"),
        }),
      );
      github.createGitHubAppJwt.mockResolvedValue("app-jwt");
      github.createGitHubProvider.mockReturnValue(provider);

      const authorization = authorize().then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      );
      await vi.waitFor(() =>
        expect(provider.revokeInstallationToken).toHaveBeenCalledWith(
          lease.token,
        ),
      );

      const outcome = Promise.race([
        authorization,
        new Promise<"timed-out">((resolve) =>
          setTimeout(() => resolve("timed-out"), 2_000),
        ),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(outcome).resolves.toBe("rejected");

      revocation.reject(new Error("revocation unavailable"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("project source binding admission", () => {
  const authorizeBinding = (binding: Record<string, string | number | null>) =>
    authorizeProjectSource({
      db: {
        prepare: () => ({
          bind: () => ({ first: async () => binding }),
        }),
      } as unknown as D1Database,
      bindings: {} as never,
      projectId: "project-233",
      ownerUserId: "user-233",
    });

  it("admits a repository whose LEFT JOIN has no authority row anonymously", async () => {
    await expect(
      authorizeBinding({
        provider: "github",
        binding_revision: 1,
        full_name: "owner/repository",
        clone_url: "https://github.com/owner/repository.git",
        authority_project_id: null,
        owner_grant_id: null,
        provenance: null,
        source_health: null,
      }),
    ).resolves.toEqual({
      kind: "anonymous",
      bindingRevision: 1,
      provider: "github",
      repositoryName: "owner/repository",
      cloneUrl: "https://github.com/owner/repository.git",
    });
  });

  it("admits a host-neutral public Git repository without authority", async () => {
    await expect(
      authorizeBinding({
        provider: "git",
        binding_revision: 1,
        full_name: "group/owner/repository",
        clone_url: "https://git.example.test/group/owner/repository.git",
        authority_project_id: null,
        owner_grant_id: null,
        provenance: null,
        source_health: null,
      }),
    ).resolves.toEqual({
      kind: "anonymous",
      bindingRevision: 1,
      provider: "git",
      repositoryName: "group/owner/repository",
      cloneUrl: "https://git.example.test/group/owner/repository.git",
    });
  });

  it("rejects a legacy authority row with a null owner grant as stale", async () => {
    await expect(
      authorizeBinding({
        provider: "github",
        binding_revision: 1,
        full_name: "owner/repository",
        clone_url: "https://github.com/owner/repository.git",
        authority_project_id: "project-233",
        owner_grant_id: null,
        provenance: "legacy",
        source_health: "action-required",
      }),
    ).rejects.toMatchObject({ reason: "stale-binding", action: "rebind" });
  });

  it("reports a live-grant binding without a clone URL as stale", async () => {
    await expect(
      authorizeBinding({
        provider: "github",
        binding_revision: 1,
        full_name: "owner/repository",
        clone_url: null,
        authority_project_id: "project-233",
        owner_grant_id: "grant-233",
        provenance: "live-grant",
        source_health: "available",
      }),
    ).rejects.toMatchObject({ reason: "stale-binding", action: "rebind" });
  });
});
