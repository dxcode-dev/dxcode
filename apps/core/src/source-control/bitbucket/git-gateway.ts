import { SourceControlAccessDenied } from "@dx/domain";
import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { hashOAuthState } from "../../settings/integrations/provider-registry.js";
import { sourceAccessDenied } from "../authority.js";
import {
  bitbucketControlPlaneFor,
  readBitbucketThreadAuthority,
} from "./control-plane.js";
import { handleBitbucketLfs } from "./lfs-gateway.js";
import { BitbucketProviderError } from "./provider-http.js";
import { BITBUCKET_GIT_PATH } from "./runtime.js";

export interface BitbucketGitLease {
  id_hash: string;
  thread_id: string;
  actor_user_id: string;
  connection_id: string;
  repository_id: string;
  workspace_id: string;
  repository_name: string;
  authorization_epoch: number;
  binding_revision: number;
  operation: string;
  target_branch: string | null;
}
const deny = () =>
  sourceAccessDenied("provider-permission-denied", "reconnect");

export const bitbucketGitGatewayRoutes = new Hono<AppEnv>();
bitbucketGitGatewayRoutes.all("/*", async (context) => {
  const failure = (status: 401 | 403 | 503) =>
    new Response(
      status === 503
        ? "Source provider unavailable. Retry later.\n"
        : "Source access denied. Reconnect or check repository access.\n",
      {
        status,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
          ...(status === 401
            ? { "WWW-Authenticate": 'Basic realm="dx source"' }
            : {}),
        },
      },
    );
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Basic ")) return failure(401);
  let credentials: string;
  try {
    credentials = atob(authorization.slice(6));
  } catch {
    return failure(401);
  }
  const token = /^dx:([a-f0-9-]{72})$/.exec(credentials)?.[1];
  if (!token) return failure(401);
  try {
    const db = await Effect.runPromise(decodeD1Binding(context.env.DB));
    const lease = await db
      .prepare(
        "SELECT * FROM bitbucket_git_lease WHERE id_hash = ? AND expires_at > ?",
      )
      .bind(await hashOAuthState(token), new Date().toISOString())
      .first<BitbucketGitLease>();
    if (!lease) return failure(403);
    const authority = await readBitbucketThreadAuthority(
      db,
      lease.thread_id,
      lease.actor_user_id,
    );
    if (
      authority.grantId !== lease.connection_id ||
      authority.authorizationEpoch !== lease.authorization_epoch ||
      authority.bindingRevision !== lease.binding_revision ||
      authority.providerRepositoryId !== lease.repository_id ||
      authority.providerWorkspaceId !== lease.workspace_id ||
      authority.repositoryName !== lease.repository_name
    )
      return failure(403);
    const url = new URL(context.req.url);
    const root = `${BITBUCKET_GIT_PATH}/${lease.repository_name}.git`;
    const suffix = url.pathname.slice(root.length);
    if (!url.pathname.startsWith(`${root}/`) || /[%\\]/.test(url.pathname))
      return failure(403);
    const lfs = suffix.startsWith("/info/lfs/") && url.search === "";
    const service = url.searchParams.get("service");
    const read =
      (context.req.method === "GET" &&
        suffix === "/info/refs" &&
        service === "git-upload-pack") ||
      (context.req.method === "POST" &&
        suffix === "/git-upload-pack" &&
        url.search === "");
    const write =
      (context.req.method === "GET" &&
        suffix === "/info/refs" &&
        service === "git-receive-pack") ||
      (context.req.method === "POST" &&
        suffix === "/git-receive-pack" &&
        url.search === "");
    if (!read && !write && !lfs) return failure(403);
    if (
      !lfs &&
      context.req.method === "GET" &&
      url.search !== `?service=${service}`
    )
      return failure(403);
    if (write && lease.operation !== "contents-push") return failure(403);
    if (context.req.header("content-encoding")) return failure(403);
    const body =
      context.req.method === "POST" ? context.req.raw.body : undefined;
    const control = await bitbucketControlPlaneFor(db, context.env);
    const response = await control.withConnection(
      lease.actor_user_id,
      lease.connection_id,
      async (accessToken, connection, provider) => {
        if (connection.authorization_epoch !== lease.authorization_epoch)
          throw deny();
        const repository = await provider.getRepository(
          accessToken,
          lease.workspace_id,
          lease.repository_id,
        );
        if (
          repository.id !== lease.repository_id ||
          repository.fullName !== lease.repository_name ||
          repository.workspaceId !== lease.workspace_id
        )
          throw deny();
        const current = await readBitbucketThreadAuthority(
          db,
          lease.thread_id,
          lease.actor_user_id,
        );
        const liveLease = await db
          .prepare(
            "SELECT id_hash FROM bitbucket_git_lease WHERE id_hash = ? AND expires_at > ?",
          )
          .bind(lease.id_hash, new Date().toISOString())
          .first();
        if (
          !liveLease ||
          current.authorizationEpoch !== lease.authorization_epoch ||
          current.bindingRevision !== lease.binding_revision
        )
          throw deny();
        if (lfs)
          return handleBitbucketLfs({
            request: context.req.raw,
            suffix,
            gatewayRepositoryUrl: new URL(root, context.env.DX_AUTH_URL).href,
            lease,
            leaseToken: token,
            accessToken,
            db,
            bindings: context.env,
          });
        const headers = new Headers({
          authorization: `Basic ${btoa(`x-token-auth:${accessToken}`)}`,
        });
        if (context.req.method === "POST")
          headers.set(
            "content-type",
            `application/x-${write ? "git-receive-pack" : "git-upload-pack"}-request`,
          );
        if (context.req.header("git-protocol") === "version=2")
          headers.set("git-protocol", "version=2");
        // No user-controlled upstream host, path, headers, cookies, or redirects.
        const result = await fetch(
          `https://bitbucket.org/${lease.repository_name}.git${suffix}${url.search}`,
          {
            method: context.req.method,
            headers,
            body,
            redirect: "manual",
            signal: AbortSignal.timeout(120_000),
          },
        );
        if (result.status === 401)
          throw new BitbucketProviderError({ category: "unauthorized" });
        if (result.status === 403 || result.status === 404) throw deny();
        if (!result.ok) {
          await result.body?.cancel();
          throw new BitbucketProviderError({ category: "unavailable" });
        }
        return result;
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  } catch (cause) {
    return failure(
      cause instanceof SourceControlAccessDenied ||
        (cause instanceof BitbucketProviderError &&
          ["unauthorized", "forbidden", "not-found", "invalid-grant"].includes(
            cause.category,
          ))
        ? 403
        : 503,
    );
  }
});
