import {
  type EnvironmentVariableId,
  type GitIntegrationProvider,
  type IntegrationOwner,
  integrationCredentialReferenceFor,
  type McpServerId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { settingsAuditLogger } from "../../logging.js";
import {
  type ConfigEncryptionKeyring,
  loadConfigEncryptionKeyring,
} from "../config-encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../integrations/credential-vault.js";
import {
  type GitProviderClient,
  IntegrationProviderRequestFailed,
  loadIntegrationProviderRegistry,
} from "../integrations/provider-registry.js";
import {
  createMcpOAuthFetch,
  McpOAuthFailed,
  revokeMcpOAuthGrant,
} from "../mcp-servers/oauth.js";
import { readMcpOAuthGrant } from "../mcp-servers/secrets.js";

/** How long one provider may take to answer before dx gives up on it. */
const REVOCATION_TIMEOUT_MS = 5_000;
/** Providers asked at once. */
const REVOCATION_CONCURRENCY = 4;

/** What a workspace deletion needs to ask providers to revoke tokens. */
export interface WorkspaceCredentialRevoker {
  /** Undefined when the deployment cannot decrypt credentials. */
  readonly keyring: ConfigEncryptionKeyring | undefined;
  /** The configured OAuth client for a Git provider, if any. */
  readonly integrationClient: (
    provider: GitIntegrationProvider,
  ) => GitProviderClient | undefined;
  /** Egress-checked fetch for MCP authorization servers. */
  readonly mcpFetch: typeof fetch;
}

export const workspaceCredentialRevoker = async (
  bindings: Bindings,
): Promise<WorkspaceCredentialRevoker> => {
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  let registry: ReturnType<typeof loadIntegrationProviderRegistry> = [];
  try {
    registry = loadIntegrationProviderRegistry(bindings);
  } catch {
    // An unparsable provider configuration revokes nothing; each
    // connection's revocation is then audited as failed.
  }
  return {
    keyring,
    integrationClient: (provider) =>
      registry.find(
        (registration) =>
          registration.provider === provider && registration.available,
      )?.client,
    mcpFetch: createMcpOAuthFetch(),
  };
};

type Subject =
  | {
      readonly credential: "integration";
      readonly integrationProvider: GitIntegrationProvider;
      readonly integrationConnectionId: string;
    }
  | {
      readonly credential: "mcp-oauth";
      readonly mcpServerId: string;
      readonly credentialUserId: string;
    };

type FailureReason =
  | "unreadable"
  | "provider-unconfigured"
  | "provider-rejected"
  | "request-failed"
  | "timeout";

class RevocationFailed extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

interface Revocation {
  readonly subject: Subject;
  /** Resolves "unsupported" when the provider has no revocation endpoint. */
  readonly revoke: () => Promise<"completed" | "unsupported">;
}

const failing = (subject: Subject, reason: FailureReason): Revocation => ({
  subject,
  revoke: () => Promise.reject(new RevocationFailed(reason)),
});

const IntegrationRow = Schema.Struct({
  id: Schema.String,
  provider: Schema.Literals(["github", "gitlab", "forgejo"]),
  access_token_reference_id: Schema.String,
  refresh_token_reference_id: Schema.NullOr(Schema.String),
});

/** The workspace's Git connections that still hold a token. */
const integrationRevocations = async (
  db: D1Database,
  workspaceId: string,
  revoker: WorkspaceCredentialRevoker,
): Promise<ReadonlyArray<Revocation>> => {
  const rows = Schema.decodeUnknownSync(Schema.Array(IntegrationRow))(
    (
      await db
        .prepare(
          `SELECT id, provider, access_token_reference_id, refresh_token_reference_id
             FROM integration_connection
            WHERE owner_scope = 'workspace' AND owner_id = ?
              AND access_token_reference_id IS NOT NULL`,
        )
        .bind(workspaceId)
        .all()
    ).results,
  );
  const owner = { scope: "workspace", id: workspaceId } as IntegrationOwner;
  return Promise.all(
    rows.map(async (row): Promise<Revocation> => {
      const subject: Subject = {
        credential: "integration",
        integrationProvider: row.provider,
        integrationConnectionId: row.id,
      };
      const client = revoker.integrationClient(row.provider);
      if (client === undefined)
        return failing(subject, "provider-unconfigured");
      const keyring = revoker.keyring;
      if (keyring === undefined) return failing(subject, "unreadable");
      const tokens = await Effect.runPromise(
        Effect.gen(function* () {
          const vault = yield* IntegrationCredentialVault;
          const read = (
            purpose: "access-token" | "refresh-token",
            id: string,
          ) =>
            vault.read(
              keyring,
              owner,
              purpose,
              integrationCredentialReferenceFor(id as EnvironmentVariableId),
            );
          const accessToken = yield* read(
            "access-token",
            row.access_token_reference_id,
          );
          const refreshToken =
            row.refresh_token_reference_id === null
              ? undefined
              : yield* read("refresh-token", row.refresh_token_reference_id);
          return {
            accessToken,
            ...(refreshToken === undefined ? {} : { refreshToken }),
          };
        }).pipe(
          Effect.provide(IntegrationCredentialVaultD1(db)),
          Effect.orElseSucceed(() => undefined),
        ),
      );
      if (tokens === undefined) return failing(subject, "unreadable");
      return {
        subject,
        revoke: async () => {
          await client.revoke(tokens);
          return "completed";
        },
      };
    }),
  );
};

/** Every person's sign-in to the workspace's MCP servers. */
const mcpRevocations = async (
  db: D1Database,
  workspaceId: string,
  revoker: WorkspaceCredentialRevoker,
): Promise<ReadonlyArray<Revocation>> => {
  const rows = (
    await db
      .prepare(
        `SELECT grant_row.server_id, grant_row.user_id
           FROM mcp_oauth_grant grant_row
           JOIN mcp_server ON mcp_server.id = grant_row.server_id
          WHERE mcp_server.scope = 'workspace' AND mcp_server.target_id = ?`,
      )
      .bind(workspaceId)
      .all<{ server_id: string; user_id: string }>()
  ).results;
  return Promise.all(
    rows.map(async (row): Promise<Revocation> => {
      const subject: Subject = {
        credential: "mcp-oauth",
        mcpServerId: row.server_id,
        credentialUserId: row.user_id,
      };
      const keyring = revoker.keyring;
      if (keyring === undefined) return failing(subject, "unreadable");
      const grant = await readMcpOAuthGrant(
        db,
        keyring,
        {
          id: row.server_id as McpServerId,
          target: { scope: "workspace", id: workspaceId } as never,
        },
        row.user_id,
      ).catch(() => undefined);
      if (grant === undefined) return failing(subject, "unreadable");
      return {
        subject,
        revoke: () => revokeMcpOAuthGrant(grant.payload, revoker.mcpFetch),
      };
    }),
  );
};

const reasonOf = (error: unknown): FailureReason => {
  if (error instanceof RevocationFailed) return error.reason;
  if (
    error instanceof IntegrationProviderRequestFailed ||
    error instanceof McpOAuthFailed
  )
    return "provider-rejected";
  return "request-failed";
};

const withTimeout = <A>(operation: () => Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RevocationFailed("timeout")),
        REVOCATION_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Asks each provider to revoke the OAuth tokens a workspace deletion is
 * about to erase (#1299): its Git connections' tokens and every person's
 * sign-in to its MCP servers. Best effort: each credential is tried once,
 * with a timeout, and audited; a failure is logged and never thrown, so it
 * cannot block the deletion. No token is ever logged.
 *
 * Personal connections (GitHub sign-in, Bitbucket, personal MCP servers)
 * are not the workspace's and are left alone.
 */
export const revokeWorkspaceCredentials = async (
  db: D1Database,
  workspaceId: string,
  actorUserId: string,
  revoker: WorkspaceCredentialRevoker,
): Promise<void> => {
  let pending: Array<Revocation>;
  try {
    pending = [
      ...(await integrationRevocations(db, workspaceId, revoker)),
      ...(await mcpRevocations(db, workspaceId, revoker)),
    ];
  } catch {
    settingsAuditLogger.warn("Workspace credentials could not be listed.", {
      event: "workspace_credential_revocation_failed",
      workspaceId,
      userId: actorUserId,
      reason: "unreadable",
    });
    return;
  }
  const audit = (
    subject: Subject,
    revocation: "completed" | "unsupported" | "failed",
  ) =>
    settingsAuditLogger.info("Settings mutation audited.", {
      event: "settings_mutation_audited",
      action: "workspace.credential.revoke",
      scope: "workspace",
      outcome: revocation === "failed" ? "rejected" : "success",
      workspaceId,
      userId: actorUserId,
      ...subject,
      revocation,
    });
  await Promise.all(
    Array.from(
      { length: Math.min(REVOCATION_CONCURRENCY, pending.length) },
      async () => {
        for (
          let next = pending.shift();
          next !== undefined;
          next = pending.shift()
        ) {
          const { subject, revoke } = next;
          try {
            audit(subject, await withTimeout(revoke));
          } catch (error) {
            settingsAuditLogger.warn("Provider token revocation failed.", {
              event: "workspace_credential_revocation_failed",
              workspaceId,
              userId: actorUserId,
              ...subject,
              reason: reasonOf(error),
            });
            audit(subject, "failed");
          }
        }
      },
    ),
  );
};
