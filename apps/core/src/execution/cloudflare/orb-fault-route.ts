import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import type { OrbFaultPlan } from "./orb-container-faults.js";

/**
 * Branch previews only (#1956): sets or clears a fault plan on the Thread's
 * Orb container (`orb-container-faults.ts`), so a preview reproduces a
 * Cloudflare restore that answers late and a stop that never confirms.
 * Anywhere else, and for anyone but the Thread's owner, it is not found.
 *
 *   POST   /v1/threads/:threadId/orb/fault
 *          { "startDelaySeconds": 150, "destroyHangs": true, "minutes": 30,
 *            "dropAfterSeconds": 540, "starts": 1 }
 *   DELETE /v1/threads/:threadId/orb/fault
 */
const FaultRequest = Schema.Struct({
  startDelaySeconds: Schema.Finite.check(
    Schema.isBetween({ minimum: 0, maximum: 1_800 }),
  ),
  destroyHangs: Schema.Boolean,
  minutes: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 240 })),
  dropAfterSeconds: Schema.optional(
    Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3_600 })),
  ),
  starts: Schema.optional(
    Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
});

interface FaultTarget {
  injectFault(plan: OrbFaultPlan | null): Promise<void>;
}

const target = (env: AppEnv["Bindings"], threadId: string) => {
  if (env.DX_ENV !== "preview" || env.DX_DEPLOYMENT_TARGET !== "branch")
    return undefined;
  const namespace = env.ORB_CONTAINER;
  if (namespace === undefined) return undefined;
  return namespace.get(
    namespace.idFromName(threadId),
  ) as unknown as FaultTarget;
};

const threadOf = (raw: string | undefined) =>
  Schema.decodeUnknownOption(ThreadId)(raw);

export const threadOrbFaultRoutes = new Hono<AppEnv>()
  .post("/:threadId/orb/fault", async (context) => {
    const threadId = threadOf(context.req.param("threadId"));
    if (Option.isNone(threadId) || context.get("threadAccess") !== "owner")
      return context.notFound();
    const orb = target(context.env, threadId.value);
    if (orb === undefined) return context.notFound();
    const request = Schema.decodeUnknownOption(FaultRequest)(
      await context.req.json().catch(() => undefined),
    );
    if (Option.isNone(request))
      return context.json({ status: "error", data: { code: "INVALID" } }, 400);
    const plan: OrbFaultPlan = {
      startDelayMs: Math.round(request.value.startDelaySeconds * 1000),
      destroyHangs: request.value.destroyHangs,
      ...(request.value.dropAfterSeconds === undefined
        ? {}
        : { dropAfterMs: Math.round(request.value.dropAfterSeconds * 1000) }),
      ...(request.value.starts === undefined
        ? {}
        : { starts: Math.round(request.value.starts) }),
      until: Date.now() + Math.round(request.value.minutes * 60_000),
    };
    await orb.injectFault(plan);
    return context.json({ status: "success", data: plan });
  })
  .delete("/:threadId/orb/fault", async (context) => {
    const threadId = threadOf(context.req.param("threadId"));
    if (Option.isNone(threadId) || context.get("threadAccess") !== "owner")
      return context.notFound();
    const orb = target(context.env, threadId.value);
    if (orb === undefined) return context.notFound();
    await orb.injectFault(null);
    return context.json({ status: "success", data: null });
  });
