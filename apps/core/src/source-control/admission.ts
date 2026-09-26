import {
  SourceControlAccessDenied,
  SourceControlProviderFailure,
} from "@dx/domain";
import { Effect, Redacted } from "effect";
import type { Bindings } from "../http/types.js";
import {
  readLiveGrantAuthority,
  type SourceOwner,
  sourceAccessDenied,
  validateLiveGrantAuthority,
} from "./authority.js";
import {
  authorizeBitbucketSource,
  recheckBitbucketThreadSource,
} from "./bitbucket/control-plane.js";
import { createGitHubAppJwt } from "./github/app-auth.js";
import { loadGitHubAppConfiguration } from "./github/configuration.js";
import {
  createGitHubProvider,
  GitHubProviderError,
  type GitHubResolvedSource,
} from "./github/provider-http.js";

export type { SourceOwner } from "./authority.js";

export interface AuthorizedSource {
  readonly provider: "github" | "bitbucket";
  readonly owner: SourceOwner;
  readonly grantId: string;
  readonly installationId?: string;
  readonly providerWorkspaceId?: string;
  readonly providerRepositoryId: string;
  readonly fullName: string;
  readonly webUrl: string;
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly visibility: "public" | "private" | "internal";
  readonly commitSha: string;
  readonly authorizationEpoch: number;
  readonly installationEpoch: number;
  readonly policyRevision: number;
}

const deny = (
  reason: ConstructorParameters<typeof SourceControlAccessDenied>[0]["reason"],
  action: ConstructorParameters<typeof SourceControlAccessDenied>[0]["action"],
) => sourceAccessDenied(reason, action);

const providerFailure = (cause: unknown) => {
  if (cause instanceof SourceControlAccessDenied) return cause;
  if (cause instanceof GitHubProviderError) {
    if (["not-found", "forbidden", "unauthorized"].includes(cause.category))
      return deny("repository-access-removed", "rebind");
    return new SourceControlProviderFailure({
      provider: "github",
      retryable:
        cause.category === "rate-limited" || cause.category === "unavailable",
    });
  }
  return new SourceControlProviderFailure({
    provider: "github",
    retryable: true,
  });
};

const INSTALLATION_DENIAL_CLEANUP_TIMEOUT_MS = 1_000;

type SettledPromise<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

const settlePromise = <T>(start: () => Promise<T>) =>
  Promise.resolve()
    .then(start)
    .then(
      (value): SettledPromise<T> => ({ status: "fulfilled", value }),
      (reason): SettledPromise<T> => ({ status: "rejected", reason }),
    );

const cleanupSettledLease = async <T>(
  leaseResult: Promise<SettledPromise<T>>,
  revoke: (lease: T) => Promise<unknown>,
  waitUntil?: (promise: Promise<unknown>) => void,
) => {
  const cleanup = leaseResult.then(async (result) => {
    if (result.status !== "fulfilled") return;
    try {
      await revoke(result.value);
    } catch {
      // Revocation is best effort; the provider lease has a natural expiry.
    }
  });
  waitUntil?.(cleanup);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, INSTALLATION_DENIAL_CLEANUP_TIMEOUT_MS);
  });
  try {
    await Promise.race([cleanup, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const authorizeSource = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly owner: SourceOwner;
  readonly grantId: string;
  readonly repositoryId: string;
  readonly provider?: "github" | "bitbucket";
  readonly workspaceId?: string;
  readonly fetcher?: typeof fetch;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<AuthorizedSource> => {
  if (input.provider === "bitbucket") {
    if (input.owner.scope !== "personal")
      throw deny("personal-grant-not-allowed-for-workspace", "rebind");
    return authorizeBitbucketSource(input);
  }
  try {
    const before = validateLiveGrantAuthority(
      await readLiveGrantAuthority(
        input.db,
        input.owner,
        input.grantId,
        input.repositoryId,
      ),
    );
    const config = await Effect.runPromise(
      loadGitHubAppConfiguration(input.bindings),
    );
    const provider = createGitHubProvider(config, input.fetcher);
    const appJwt = await createGitHubAppJwt({
      appId: config.appId,
      privateKeyPem: Redacted.value(config.privateKeyPem),
    });
    const installationResult = settlePromise(() =>
      provider
        .getInstallation(appJwt, before.installation_id)
        .then((installation) => {
          if (installation.suspendedAt !== undefined)
            throw deny("installation-suspended", "reconfigure");
          if (
            installation.permissions.contents !== "write" ||
            installation.permissions.metadata !== "read"
          )
            throw deny("installation-permissions-changed", "reconfigure");
        }),
    );
    const leaseResult = settlePromise(() =>
      provider.createInstallationToken(appJwt, before.installation_id, {
        repositoryId: input.repositoryId,
        permissions: { contents: "read", metadata: "read" },
      }),
    );
    const installation = await installationResult;
    if (installation.status === "rejected") {
      await cleanupSettledLease(
        leaseResult,
        (value) => provider.revokeInstallationToken(value.token),
        input.waitUntil,
      );
      throw installation.reason;
    }
    const leaseOutcome = await leaseResult;
    if (leaseOutcome.status === "rejected") throw leaseOutcome.reason;
    const lease = leaseOutcome.value;
    let resolved: GitHubResolvedSource;
    try {
      resolved = await provider.resolveRepositorySource(
        lease.token,
        input.repositoryId,
      );
    } finally {
      await provider
        .revokeInstallationToken(lease.token)
        .catch(() => undefined);
    }
    const after = validateLiveGrantAuthority(
      await readLiveGrantAuthority(
        input.db,
        input.owner,
        input.grantId,
        input.repositoryId,
      ),
    );
    if (
      before.grant_epoch !== after.grant_epoch ||
      before.installation_epoch !== after.installation_epoch ||
      before.policy_revision !== after.policy_revision
    )
      throw deny("stale-authorization-epoch", "retry");
    return {
      provider: "github",
      owner: input.owner,
      grantId: input.grantId,
      installationId: before.installation_id,
      providerRepositoryId: resolved.repository.id,
      fullName: resolved.repository.fullName,
      webUrl: resolved.repository.webUrl,
      cloneUrl: resolved.repository.cloneUrl,
      defaultBranch: resolved.repository.defaultBranch,
      visibility: resolved.repository.visibility,
      commitSha: resolved.commitSha,
      authorizationEpoch: before.grant_epoch,
      installationEpoch: before.installation_epoch,
      policyRevision: before.policy_revision,
    };
  } catch (cause) {
    throw providerFailure(cause);
  }
};

export const authorizeProjectSource = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly fetcher?: typeof fetch;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}) => {
  const binding = await input.db
    .prepare(`
      SELECT repository.provider, repository.binding_revision,
             repository.full_name, repository.clone_url,
             authority.project_id AS authority_project_id,
             authority.owner_scope, authority.owner_id, authority.owner_grant_id,
             authority.provider_repository_id, authority.provider_workspace_id,
             authority.provenance,
             authority.source_health
        FROM project_repository AS repository
        LEFT JOIN project_source_authority AS authority
          ON authority.project_id = repository.project_id
         AND authority.binding_revision = repository.binding_revision
       WHERE repository.project_id = ?
         AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_user_id = ?)
    `)
    .bind(input.projectId, input.projectId, input.ownerUserId)
    .first<Record<string, string | number | null>>();
  if (binding === null) return undefined;
  if (binding.authority_project_id === null) {
    if (
      !["git", "github", "bitbucket"].includes(String(binding.provider)) ||
      typeof binding.clone_url !== "string" ||
      typeof binding.full_name !== "string"
    )
      throw deny("stale-binding", "rebind");
    return {
      kind: "anonymous" as const,
      bindingRevision: Number(binding.binding_revision),
      provider: binding.provider as "git" | "github" | "bitbucket",
      repositoryName: binding.full_name,
      cloneUrl: binding.clone_url,
    };
  }
  if (binding.owner_grant_id === null) throw deny("stale-binding", "rebind");
  if (
    binding.provenance !== "live-grant" ||
    binding.source_health !== "available" ||
    typeof binding.clone_url !== "string"
  )
    throw deny("stale-binding", "rebind");
  const source = await authorizeSource({
    db: input.db,
    bindings: input.bindings,
    owner: {
      scope: binding.owner_scope as "personal" | "workspace",
      id: String(binding.owner_id),
    },
    grantId: String(binding.owner_grant_id),
    repositoryId: String(binding.provider_repository_id),
    provider: binding.provider as "github" | "bitbucket",
    ...(binding.provider_workspace_id === null
      ? {}
      : { workspaceId: String(binding.provider_workspace_id) }),
    fetcher: input.fetcher,
    waitUntil: input.waitUntil,
  });
  return {
    kind: "authorized" as const,
    ...source,
    bindingRevision: Number(binding.binding_revision),
  };
};

export const authorizeThreadSource = async (input: {
  readonly db: D1Database;
  readonly bindings: Bindings;
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly fetcher?: typeof fetch;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}) => {
  const row = await input.db
    .prepare(`
      SELECT thread.project_id, snapshot.binding_revision,
             authority.owner_grant_id, authority.installation_id,
             authority.provider_repository_id, authority.authorization_epoch,
             authority.installation_epoch, authority.policy_revision,
             repository.project_id AS repository_project_id,
             intent.thread_id AS intent_thread_id
        FROM threads AS thread
        LEFT JOIN thread_source_snapshot AS snapshot ON snapshot.thread_id = thread.id
        LEFT JOIN thread_source_authority AS authority ON authority.thread_id = thread.id
        LEFT JOIN thread_source_intent AS intent ON intent.thread_id = thread.id
        LEFT JOIN project_repository AS repository ON repository.project_id = thread.project_id
       WHERE thread.id = ? AND thread.owner_user_id = ?
    `)
    .bind(input.threadId, input.ownerUserId)
    .first<Record<string, string | number | null>>();
  if (row === null || row.repository_project_id === null) return;
  if (row.owner_grant_id === null) return;
  const provider = await input.db
    .prepare("SELECT provider FROM thread_source_snapshot WHERE thread_id = ?")
    .bind(input.threadId)
    .first<{ provider: string }>();
  if (provider?.provider === "bitbucket") {
    await recheckBitbucketThreadSource(input);
    return;
  }
  const source = await authorizeProjectSource({
    db: input.db,
    bindings: input.bindings,
    projectId: String(row.project_id),
    ownerUserId: input.ownerUserId,
    fetcher: input.fetcher,
    waitUntil: input.waitUntil,
  });
  if (
    source === undefined ||
    source.kind !== "authorized" ||
    source.bindingRevision !== Number(row.binding_revision) ||
    source.grantId !== row.owner_grant_id ||
    source.installationId !== row.installation_id ||
    source.providerRepositoryId !== row.provider_repository_id ||
    source.authorizationEpoch !== Number(row.authorization_epoch) ||
    source.installationEpoch !== Number(row.installation_epoch) ||
    source.policyRevision !== Number(row.policy_revision)
  )
    throw deny("stale-snapshot", "rebind");
};
