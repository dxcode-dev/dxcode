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
          const authority = await readBitbucketThreadAuthority(
            db,
            threadId,
            actorUserId,
          );
          if (
            targetRepositoryId !== undefined &&
            targetRepositoryId !== authority.providerRepositoryId
          )
            throw sourceAccessDenied("repository-not-selected", "rebind");
          const service = await bitbucketControlPlaneFor(db, bindings);
          await service.withConnection(
            actorUserId,
            authority.grantId,
            async (token, row, provider) => {
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
            },
          );
          const after = await readBitbucketThreadAuthority(
            db,
            threadId,
            actorUserId,
          );
          if (JSON.stringify(after) !== JSON.stringify(authority))
            throw sourceAccessDenied("stale-authorization-epoch", "retry");
          const token = crypto.randomUUID() + crypto.randomUUID();
          const id = await hashOAuthState(token);
          await db.batch([
            db
              .prepare("DELETE FROM bitbucket_git_lease WHERE expires_at <= ?")
              .bind(new Date().toISOString()),
            db
              .prepare(`INSERT INTO bitbucket_git_lease (id_hash,thread_id,actor_user_id,connection_id,repository_id,workspace_id,repository_name,authorization_epoch,binding_revision,operation,target_branch,expires_at,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .bind(
                id,
                threadId,
                actorUserId,
                authority.grantId,
                authority.providerRepositoryId,
                authority.providerWorkspaceId,
                authority.repositoryName,
                authority.authorizationEpoch,
                authority.bindingRevision,
                request.operation,
                request.targetBranch ?? null,
                new Date(Date.now() + 180_000).toISOString(),
                new Date().toISOString(),
              ),
          ]);
          const origin = new URL(bindings.DX_AUTH_URL as string).origin;
          if (!origin.startsWith("https://"))
            throw sourceAccessDenied("provider-disabled", "reconfigure");
          return {
            id,
            environment: bitbucketCommandEnvironment(
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
