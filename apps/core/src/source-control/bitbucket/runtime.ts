import { Effect } from "effect";
import type { Bindings } from "../../http/types.js";
import { hashOAuthState } from "../../settings/integrations/provider-registry.js";
import { sourceAccessDenied } from "../authority.js";
import { githubCommandEnvironment } from "../github/runtime-adapter.js";
import {
  SourceRuntimeBroker,
  type SourceRuntimeBrokerShape,
} from "../runtime.js";
import {
  bitbucketControlPlaneFor,
  mapBitbucketSourceError,
  readBitbucketThreadAuthority,
} from "./control-plane.js";

export const BITBUCKET_GIT_PATH = "/api/source/bitbucket/git";
export const bitbucketCommandEnvironment = (
  origin: string,
  token: string,
  repositoryName: string,
) => {
  const base = githubCommandEnvironment("", repositoryName);
  const index = Number(base.GIT_CONFIG_COUNT);
  return Object.freeze({
    ...base,
    DX_SOURCE_PROVIDER: "bitbucket",
    DX_BITBUCKET_GIT_TOKEN: token,
    DX_BITBUCKET_GIT_ORIGIN: origin,
    DX_BITBUCKET_GIT_PATH: BITBUCKET_GIT_PATH,
    GIT_CONFIG_COUNT: String(index + 2),
    [`GIT_CONFIG_KEY_${index}`]: `url.${origin}${BITBUCKET_GIT_PATH}/${repositoryName}.git.insteadOf`,
    [`GIT_CONFIG_VALUE_${index}`]: `https://bitbucket.org/${repositoryName}.git`,
    [`GIT_CONFIG_KEY_${index + 1}`]: "http.followRedirects",
    [`GIT_CONFIG_VALUE_${index + 1}`]: "false",
  });
};

/**
 * Leases authorize the Thread owner's Bitbucket connection. The gateway takes
 * the repository from each request path and Bitbucket decides access, so a
 * native Git lease reaches every repository the owner can reach. Trusted dx
 * commands still recheck the Thread source before operating on it.
 */
export const bitbucketRuntimeBroker = (
  db: D1Database,
  bindings: Bindings,
): SourceRuntimeBrokerShape =>
  SourceRuntimeBroker.of({
    withCommandEnvironment: (
      threadId,
      actorUserId,
      request,
      callback,
      targetRepositoryId,
    ) => {
      const acquire = Effect.tryPromise({
        try: async () => {
          if (
            !["checkout", "fetch", "repository-read", "contents-push"].includes(
              request.operation,
            )
          )
            throw sourceAccessDenied("unsupported-capability", "reconfigure");
          const origin = new URL(bindings.DX_AUTH_URL as string).origin;
          if (!origin.startsWith("https://"))
            throw sourceAccessDenied("provider-disabled", "reconfigure");
          const native = request.invocationSource === "git-helper";
          const authority = native
            ? undefined
            : await readBitbucketThreadAuthority(db, threadId, actorUserId);
          if (
            authority !== undefined &&
            targetRepositoryId !== undefined &&
            targetRepositoryId !== authority.providerRepositoryId
          )
            throw sourceAccessDenied("repository-not-selected", "rebind");
          if (
            native &&
            (await db
              .prepare(
                "SELECT 1 AS live FROM threads WHERE id = ? AND owner_user_id = ? AND lifecycle_state = 'active'",
              )
              .bind(threadId, actorUserId)
              .first()) === null
          )
            throw sourceAccessDenied("source-not-found", "retry");
          const service = await bitbucketControlPlaneFor(db, bindings);
          const connection = await service.withConnection(
            actorUserId,
            authority?.grantId,
            async (token, row, provider) => {
              if (authority === undefined) return row;
              if (row.authorization_epoch !== authority.authorizationEpoch)
                throw sourceAccessDenied("stale-authorization-epoch", "retry");
              const repository = await provider.getRepository(
                token,
                authority.providerWorkspaceId,
                authority.providerRepositoryId,
              );
              if (
                repository.id !== authority.providerRepositoryId ||
                repository.fullName !== authority.repositoryName
              )
                throw sourceAccessDenied("stale-binding", "rebind");
              return row;
            },
          );
          if (
            authority !== undefined &&
            JSON.stringify(
              await readBitbucketThreadAuthority(db, threadId, actorUserId),
            ) !== JSON.stringify(authority)
          )
            throw sourceAccessDenied("stale-authorization-epoch", "retry");
          const token = crypto.randomUUID() + crypto.randomUUID();
          const id = await hashOAuthState(token);
          await db.batch([
            db
              .prepare("DELETE FROM bitbucket_git_lease WHERE expires_at <= ?")
              .bind(new Date().toISOString()),
            db
              .prepare(`INSERT INTO bitbucket_git_lease (id_hash,thread_id,actor_user_id,connection_id,authorization_epoch,operation,expires_at,created_at)
            VALUES (?,?,?,?,?,?,?,?)`)
              .bind(
                id,
                threadId,
                actorUserId,
                connection.id,
                connection.authorization_epoch,
                request.operation,
                new Date(Date.now() + 180_000).toISOString(),
                new Date().toISOString(),
              ),
          ]);
          return {
            id,
            environment:
              authority === undefined
                ? Object.freeze({
                    DX_SOURCE_PROVIDER: "bitbucket",
                    DX_BITBUCKET_GIT_TOKEN: token,
                  })
                : bitbucketCommandEnvironment(
                    origin,
                    token,
                    authority.repositoryName,
                  ),
          };
        },
        catch: mapBitbucketSourceError,
      });
      return Effect.acquireUseRelease(
        acquire,
        (lease) => callback(lease.environment),
        (lease) =>
          request.invocationSource === "git-helper"
            ? Effect.void
            : Effect.tryPromise(async () => {
                await db
                  .prepare("DELETE FROM bitbucket_git_lease WHERE id_hash = ?")
                  .bind(lease.id)
                  .run();
              }).pipe(Effect.ignore),
      );
    },
  });
