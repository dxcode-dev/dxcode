import {
  GITHUB_APP_REPOSITORY_PERMISSIONS,
  SourceControlAccessDenied,
  SourceControlLeaseFailure,
  SourceControlProviderFailure,
  type SourceOperationType,
} from "@dx/domain";
import { Context, Effect, Layer, Redacted } from "effect";
import type { Bindings } from "../../http/types.js";
import { sourceAccessDenied } from "../authority.js";
import type { RuntimeSourceAuthority } from "../runtime-authority.js";
import { GIT_CREDENTIAL_HELPER_PATH } from "../workspace-assets.js";
import { createGitHubAppJwt } from "./app-auth.js";
import { loadGitHubAppConfiguration } from "./configuration.js";
import { createGitHubProvider, GitHubProviderError } from "./provider-http.js";

export type GitHubRuntimePermissions = Readonly<
  Partial<
    Record<keyof typeof GITHUB_APP_REPOSITORY_PERMISSIONS, "read" | "write">
  >
>;

const minimumPermissions = {
  checkout: { contents: "read", metadata: "read" },
  fetch: { contents: "read", metadata: "read" },
  "provider-auth-read": { metadata: "read" },
  "repository-read": { contents: "read", metadata: "read" },
  "contents-push": { contents: "write", metadata: "read" },
  "pull-request-read": { metadata: "read", pull_requests: "read" },
  "pull-request-write": { metadata: "read", pull_requests: "write" },
  "issue-read": { issues: "read", metadata: "read" },
  "issue-write": { issues: "write", metadata: "read" },
  "actions-read": { actions: "read", metadata: "read" },
  "actions-write": { actions: "write", metadata: "read" },
  "workflow-write": {
    contents: "write",
    metadata: "read",
    workflows: "write",
  },
  "checks-status-read": {
    checks: "read",
    metadata: "read",
    pull_requests: "read",
    statuses: "read",
  },
} as const satisfies Record<SourceOperationType, GitHubRuntimePermissions>;

export const githubPermissionsForOperation = (operation: SourceOperationType) =>
  minimumPermissions[operation];

/** Least permission set covering every requested operation. */
export const githubPermissionsForOperations = (
  operations: ReadonlyArray<SourceOperationType>,
): GitHubRuntimePermissions => {
  const permissions: Partial<
    Record<keyof typeof GITHUB_APP_REPOSITORY_PERMISSIONS, "read" | "write">
  > = {};
  for (const operation of operations)
    for (const [name, level] of Object.entries(
      minimumPermissions[operation],
    ) as Array<
      [keyof typeof GITHUB_APP_REPOSITORY_PERMISSIONS, "read" | "write"]
    >)
      if (permissions[name] !== "write") permissions[name] = level;
  return permissions;
};

export const GITHUB_CONFIG_DIRECTORY = "/home/user/.config/dx/gh";

const gitConfiguration = [
  ["credential.helper", ""],
  ["credential.helper", GIT_CREDENTIAL_HELPER_PATH],
  ["credential.useHttpPath", "true"],
  ["credential.interactive", "false"],
  ["core.hooksPath", "/dev/null"],
  ["init.templateDir", "/home/user/.local/share/dx/empty-template"],
  ["http.extraHeader", ""],
  ["http.proxy", ""],
  ["protocol.file.allow", "never"],
  ["protocol.ext.allow", "never"],
  ["protocol.ssh.allow", "never"],
  ["protocol.git.allow", "never"],
  ["http.followRedirects", "initial"],
] as const;

export const githubCommandEnvironment = (
  token: string,
  repositoryName: string,
) =>
  Object.freeze({
    DX_SOURCE_PROVIDER: "github",
    GH_TOKEN: token,
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
    GH_DEBUG: "",
    GH_HOST: "github.com",
    GH_REPO: repositoryName,
    GH_CONFIG_DIR: GITHUB_CONFIG_DIRECTORY,
    GH_PROMPT_DISABLED: "1",
    DX_GIT_ALLOWED_PATH: repositoryName,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    SSH_ASKPASS_REQUIRE: "force",
    GIT_SSH: "",
    GIT_SSH_COMMAND: "/bin/false",
    GIT_PROXY_COMMAND: "",
    GIT_EXEC_PATH: "",
    GIT_CONFIG_PARAMETERS: "",
    SSH_AUTH_SOCK: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    GIT_TRACE: "",
    GIT_TRACE_PACKET: "",
    GIT_TRACE_PACK_ACCESS: "",
    GIT_TRACE_PERFORMANCE: "",
    GIT_TRACE_SETUP: "",
    GIT_TRACE_SHALLOW: "",
    GIT_TRACE_CURL: "",
    GIT_TRACE_CURL_NO_DATA: "1",
    GIT_TRACE2: "",
    GIT_TRACE2_EVENT: "",
    GIT_TRACE2_PERF: "",
    GIT_TRACE2_BRIEF: "",
    GIT_TRACE2_CONFIG_PARAMS: "",
    GIT_TRACE2_ENV_VARS: "",
    GIT_TRACE2_DST_DEBUG: "",
    GIT_CURL_VERBOSE: "",
    GIT_TRACE_REDACT: "1",
    GIT_CONFIG_COUNT: String(gitConfiguration.length),
    ...Object.fromEntries(
      gitConfiguration.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  });

interface GitHubRuntimeCredential {
  readonly environment: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
  readonly revoke: Effect.Effect<void, SourceControlLeaseFailure>;
}

export interface GitHubRuntimeAdapterShape {
  readonly acquire: (
    authority: RuntimeSourceAuthority,
    operations: ReadonlyArray<SourceOperationType>,
    lifecycle?: {
      readonly issued: () => void;
      readonly revokeFailed: () => void;
    },
  ) => Effect.Effect<
    GitHubRuntimeCredential,
    | SourceControlAccessDenied
    | SourceControlProviderFailure
    | SourceControlLeaseFailure
  >;
}

export class GitHubRuntimeAdapter extends Context.Service<
  GitHubRuntimeAdapter,
  GitHubRuntimeAdapterShape
>()("@dx/core/source-control/github/GitHubRuntimeAdapter") {}

const mapProviderError = (cause: unknown) => {
  if (cause instanceof SourceControlAccessDenied) return cause;
  if (cause instanceof SourceControlLeaseFailure) return cause;
  if (cause instanceof GitHubProviderError) {
    if (cause.category === "rate-limited")
      return sourceAccessDenied("provider-rate-limited", "retry");
    if (["forbidden", "not-found", "unauthorized"].includes(cause.category))
      return sourceAccessDenied("provider-permission-denied", "reconfigure");
    return new SourceControlProviderFailure({
      provider: "github",
      retryable: cause.category === "unavailable",
    });
  }
  return new SourceControlProviderFailure({
    provider: "github",
    retryable: true,
  });
};

export const githubInstallationHasApprovedEnvelope = (
  permissions: Readonly<Record<string, "read" | "write">>,
  accountType: "Organization" | "User",
) => {
  const expected = {
    ...GITHUB_APP_REPOSITORY_PERMISSIONS,
    ...(accountType === "Organization"
      ? { organization_projects: "write" as const }
      : {}),
  } as const;
  return (
    Object.keys(permissions).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([name, level]) => permissions[name] === level,
    )
  );
};

export const GitHubRuntimeAdapterLive = (input: {
  readonly bindings: Bindings;
  readonly fetcher?: typeof fetch;
  readonly clock?: () => Date;
}) =>
  Layer.effect(
    GitHubRuntimeAdapter,
    Effect.gen(function* () {
      const config = yield* loadGitHubAppConfiguration(input.bindings);
      const clock = input.clock ?? (() => new Date());
      const provider = createGitHubProvider(config, input.fetcher, clock);
      return GitHubRuntimeAdapter.of({
        acquire: (authority, operations, lifecycle) =>
          Effect.tryPromise({
            try: async () => {
              const appJwt = await createGitHubAppJwt({
                appId: config.appId,
                privateKeyPem: Redacted.value(config.privateKeyPem),
                now: clock(),
              });
              const installation = await provider.getInstallation(
                appJwt,
                authority.installationId,
              );
              if (
                installation.id !== authority.installationId ||
                installation.account.id !== authority.providerAccountId
              )
                throw sourceAccessDenied("stale-binding", "rebind");
              if (installation.suspendedAt !== undefined)
                throw sourceAccessDenied(
                  "installation-suspended",
                  "reconfigure",
                );
              if (
                !githubInstallationHasApprovedEnvelope(
                  installation.permissions,
                  installation.account.type,
                )
              )
                throw sourceAccessDenied(
                  "installation-permissions-changed",
                  "reconfigure",
                );
              const lease = await provider.createInstallationToken(
                appJwt,
                authority.installationId,
                {
                  repositoryId: authority.providerRepositoryId,
                  permissions: githubPermissionsForOperations(operations),
                },
              );
              lifecycle?.issued();
              const ttl = lease.expiresAt.getTime() - clock().getTime();
              if (ttl <= 0 || ttl > 60 * 60 * 1_000) {
                await provider
                  .revokeInstallationToken(lease.token)
                  .catch(() => {
                    lifecycle?.revokeFailed();
                  });
                throw new SourceControlLeaseFailure({
                  reason: "credential-expiry-invalid",
                  retryable: false,
                });
              }
              try {
                const repository = await provider.getRepository(
                  lease.token,
                  authority.providerRepositoryId,
                );
                if (
                  repository.id !== authority.providerRepositoryId ||
                  repository.fullName.toLowerCase() !==
                    authority.repositoryName.toLowerCase()
                )
                  throw sourceAccessDenied(
                    "repository-access-removed",
                    "rebind",
                  );
              } catch (cause) {
                await provider
                  .revokeInstallationToken(lease.token)
                  .catch(() => {
                    lifecycle?.revokeFailed();
                  });
                throw cause;
              }
              return {
                environment: githubCommandEnvironment(
                  lease.token,
                  authority.repositoryName,
                ),
                expiresAt: lease.expiresAt,
                revoke: Effect.tryPromise({
                  try: () => provider.revokeInstallationToken(lease.token),
                  catch: () =>
                    new SourceControlLeaseFailure({
                      reason: "token-revoke-failed",
                      retryable: false,
                    }),
                }),
              };
            },
            catch: mapProviderError,
          }),
      });
    }),
  );
