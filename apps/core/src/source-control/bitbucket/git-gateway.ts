import { SourceControlAccessDenied } from "@dx/domain";
import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { hashOAuthState } from "../../settings/integrations/provider-registry.js";
import { sourceAccessDenied } from "../authority.js";
import { bitbucketControlPlaneFor } from "./control-plane.js";
import { handleBitbucketLfs } from "./lfs-gateway.js";
import { BitbucketProviderError } from "./provider-http.js";
import { BITBUCKET_GIT_PATH } from "./runtime.js";

export interface BitbucketGitLease {
  id_hash: string;
  thread_id: string;
  actor_user_id: string;
  connection_id: string;
  authorization_epoch: number;
  operation: string;
}

/** `/<workspace>/<repository>[.git]/<suffix>` below the gateway root. */
const repositoryPath = new RegExp(
  `^${BITBUCKET_GIT_PATH}/([A-Za-z0-9._-]{1,128})/([A-Za-z0-9._-]{1,128}?)(?:\\.git)?(/.*)$`,
);
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
    const url = new URL(context.req.url);
    const match = repositoryPath.exec(url.pathname);
    const [workspace, slug, suffix] = [match?.[1], match?.[2], match?.[3]];
    if (
      workspace === undefined ||
      slug === undefined ||
      suffix === undefined ||
      /[%\\]/.test(url.pathname) ||
      [workspace, slug].some((part) => /^\.+$/.test(part))
    )
      return failure(403);
    const repositoryName = `${workspace}/${slug}`;
    const root = `${BITBUCKET_GIT_PATH}/${repositoryName}.git`;
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
      async (accessToken, connection) => {
        if (connection.authorization_epoch !== lease.authorization_epoch)
          throw deny();
        const liveLease = await db
          .prepare(
            "SELECT id_hash FROM bitbucket_git_lease WHERE id_hash = ? AND expires_at > ?",
          )
          .bind(lease.id_hash, new Date().toISOString())
          .first();
        if (!liveLease) throw deny();
        if (lfs)
          return handleBitbucketLfs({
            request: context.req.raw,
            suffix,
            gatewayRepositoryUrl: new URL(root, context.env.DX_AUTH_URL).href,
            lease,
            repositoryName,
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
          `https://bitbucket.org/${repositoryName}.git${suffix}${url.search}`,
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
