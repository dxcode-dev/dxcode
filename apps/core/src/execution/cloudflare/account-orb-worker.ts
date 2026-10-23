/**
 * The account Orb Worker: what dx deploys into a person's or workspace's
 * own Cloudflare account when they connect it (tasks/orb-provider-
 * connections.md). It holds the same Orb container object as the
 * deployment's Orb Worker. Core is in another account, so it cannot bind
 * the namespace; it calls each Thread's object through this Worker's
 * authenticated HTTPS front instead.
 *
 * Every request carries `Authorization: Bearer <DX_ORB_WORKER_SECRET>`, the
 * secret dx generated for the connection and uploaded as a secret binding.
 * `POST /rpc` runs one container object method for one Thread; bytes travel
 * as base64. `GET /health` answers once the Worker is serving, with the
 * preparation recipe it was uploaded for.
 *
 * Core bundles this module into `account-orb-worker.generated.js` with
 * `pnpm --filter @dx/core build:account-orb-worker`, and preparation
 * uploads that bundle.
 */

import {
  ACCOUNT_ORB_PROTOCOL,
  type AccountOrbMethod,
  decodeRpcValue,
  encodeRpcValue,
  isAccountOrbMethod,
} from "./account-orb-protocol.js";
import type { OrbContainerObject } from "./orb-container-object.js";

export { OrbContainerObject } from "./orb-container-object.js";

interface Env {
  readonly ORB_CONTAINER: DurableObjectNamespace<OrbContainerObject>;
  readonly DX_ORB_WORKER_SECRET: string;
  /** The dx preparation recipe this upload was made for. */
  readonly DX_ORB_RECIPE?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Compares in time that depends only on the expected length. */
const authorized = (request: Request, secret: string) => {
  const encoder = new TextEncoder();
  const given = encoder.encode(request.headers.get("authorization") ?? "");
  const wanted = encoder.encode(`Bearer ${secret}`);
  let difference = given.byteLength ^ wanted.byteLength;
  for (let index = 0; index < wanted.byteLength; index += 1)
    difference |= (given[index] ?? 0) ^ (wanted[index] ?? 0);
  return secret.length >= 32 && difference === 0;
};

const call = async (
  stub: DurableObjectStub<OrbContainerObject>,
  method: AccountOrbMethod,
  args: ReadonlyArray<unknown>,
) => {
  const target = stub as unknown as Record<
    AccountOrbMethod,
    (...values: ReadonlyArray<unknown>) => Promise<unknown>
  >;
  return target[method](...args);
};

export default {
  async fetch(request, env) {
    if (!authorized(request, env.DX_ORB_WORKER_SECRET))
      return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return json({
        ok: true,
        protocol: ACCOUNT_ORB_PROTOCOL,
        recipe: env.DX_ORB_RECIPE ?? null,
      });
    if (request.method !== "POST" || url.pathname !== "/rpc")
      return json({ error: "not found" }, 404);
    const body = (await request.json().catch(() => undefined)) as
      | {
          readonly threadId?: unknown;
          readonly method?: unknown;
          readonly args?: unknown;
        }
      | undefined;
    if (
      typeof body?.threadId !== "string" ||
      body.threadId.length === 0 ||
      body.threadId.length > 128 ||
      !isAccountOrbMethod(body.method) ||
      !Array.isArray(body.args)
    )
      return json({ error: "invalid request" }, 400);
    const stub = env.ORB_CONTAINER.get(
      env.ORB_CONTAINER.idFromName(body.threadId),
    );
    try {
      const result = await call(
        stub,
        body.method,
        body.args.map(decodeRpcValue),
      );
      return json({ result: encodeRpcValue(result) });
    } catch (cause) {
      return json(
        {
          error:
            cause instanceof Error ? cause.message.slice(0, 500) : "failed",
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
