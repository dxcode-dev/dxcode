import {
  ORB_RESTART_FEATURE,
  ORB_RESTART_INTERVAL_SECONDS,
  RestartThreadOrbRequestSchema,
  RestartThreadOrbResponseSchema,
  type ThreadOrbRestartErrorCode,
  ThreadOrbRestartErrorResponseSchema,
} from "@dx/api";
import { type ExperimentalFeatureId, ThreadId, UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import { experimentalFeatureEnabled } from "../settings/experimental-features/routes.js";
import { userIdentity } from "../thread-sharing/service.js";
import type { OrbRestartRelayResult } from "./execution-object.js";

const restartError = (
  context: Context<AppEnv>,
  status: 403 | 409 | 429 | 503,
  code: ThreadOrbRestartErrorCode,
  message: string,
  retryAfterSeconds?: number,
  lastSavedAt?: string,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadOrbRestartErrorResponseSchema)({
      status: "error",
      data: {
        code,
        message,
        requestId: context.get("requestId"),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        ...(lastSavedAt === undefined ? {} : { lastSavedAt }),
      },
    }),
    status,
    retryAfterSeconds === undefined
      ? undefined
      : { "retry-after": String(retryAfterSeconds) },
  );

/** The Thread execution object, when this runtime has a resident one. */
const relay = async (
  env: AppEnv["Bindings"],
  threadId: ThreadId,
  by: string,
  discardUnsaved: boolean,
): Promise<OrbRestartRelayResult> => {
  try {
    selectWorkspaceRuntime(env, { local: "resident", deployed: "resident" });
  } catch {
    return { outcome: "unsupported" };
  }
  const namespace = env.THREAD_EXECUTION;
  if (namespace === undefined) return { outcome: "unsupported" };
  try {
    const response = await namespace.get(namespace.idFromName(threadId)).fetch(
      new Request("https://thread-execution/orb/restart", {
        method: "POST",
        headers: {
          "x-dx-thread-id": threadId,
          "x-dx-restarted-by": encodeURIComponent(by),
          ...(discardUnsaved ? { "x-dx-restart-discard-unsaved": "1" } : {}),
        },
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return { outcome: "failed" };
    }
    return (await response.json()) as OrbRestartRelayResult;
  } catch {
    return { outcome: "failed" };
  }
};

/**
 * Restart Orb (#1592): the Thread's provider saves the Orb and stops it, and
 * it starts again from that save, files kept, processes stopped. Owner or
 * Contribute access (authorizeThread already refuses viewers), an active
 * Thread, and at most one restart per Thread every
 * `ORB_RESTART_INTERVAL_SECONDS`. The Thread's next run tells its agent who
 * restarted the Orb, which then says so, as after an automatic restart.
 */
export const threadOrbRestartRoutes = new Hono<AppEnv>().post(
  "/:threadId/orb/restart",
  async (context) => {
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId)) return context.notFound();
    if (context.get("threadAccess") === "view")
      return restartError(
        context,
        403,
        "THREAD_READ_ONLY",
        "Only the Thread's owner and contributors can restart its Orb.",
      );
    // Behind a personal experimental feature: dx should recover Orbs on
    // its own, and this manual fallback is to go once it does.
    const enabled = await experimentalFeatureEnabled(
      context.env,
      context.get("principal"),
      ORB_RESTART_FEATURE as ExperimentalFeatureId,
    ).catch(() => false);
    if (!enabled)
      return restartError(
        context,
        403,
        "ORB_RESTART_DISABLED",
        "Restart Orb is an experimental feature. Turn it on in Settings → Experimental features.",
      );
    if (context.get("threadLifecycleState") !== "active")
      return restartError(
        context,
        409,
        "THREAD_ARCHIVED",
        "Thread is archived. Unarchive it before continuing.",
      );
    // The name dx shows for them, never their email: the next run's agent
    // tells the Thread who restarted the Orb.
    const { name } = await userIdentity(
      context.env.DB as D1Database,
      Schema.decodeUnknownSync(UserId)(context.get("principal").userId),
    );
    // An empty body is a plain restart; `discardUnsaved` is the person's
    // second confirmation after ORB_RESTART_UNSAVED.
    const body = Schema.decodeUnknownOption(RestartThreadOrbRequestSchema)(
      await context.req.json().catch(() => ({})),
    );
    const discardUnsaved =
      Option.isSome(body) && body.value.discardUnsaved === true;
    const result = await relay(
      context.env,
      threadId.value,
      name,
      discardUnsaved,
    );
    if (result.outcome === "too-soon")
      return restartError(
        context,
        429,
        "ORB_RESTART_TOO_SOON",
        `The Orb restarted less than ${ORB_RESTART_INTERVAL_SECONDS / 60} minutes ago. Try again in ${result.retryAfterSeconds} s.`,
        result.retryAfterSeconds,
      );
    if (result.outcome === "unsupported")
      return restartError(
        context,
        409,
        "ORB_RESTART_UNSUPPORTED",
        "This Orb's provider can't restart it. Archive the Thread and restore it instead.",
      );
    if (result.outcome === "unsaved") {
      const lastSavedAt =
        result.savedAt === undefined
          ? undefined
          : new Date(result.savedAt).toISOString();
      return restartError(
        context,
        409,
        "ORB_RESTART_UNSAVED",
        lastSavedAt === undefined
          ? "dx couldn't save the Orb's files first, and it has no earlier save, so it left the Orb running rather than lose them. Free space or stop heavy processes in it from the Terminal if it answers, then try again."
          : `dx couldn't save the Orb's files first (its disk may be full), so it left the Orb running rather than lose them. It can restart from its last save at ${lastSavedAt.slice(0, 16).replace("T", " ")} UTC instead; what changed since is lost, except the checkout's unsaved work, which dx tries to copy out first.`,
        undefined,
        lastSavedAt,
      );
    }
    if (result.outcome !== "restarted")
      return restartError(
        context,
        503,
        "ORB_RESTART_FAILED",
        "The Orb's restart failed. Try again.",
      );
    return context.json(
      Schema.encodeUnknownSync(RestartThreadOrbResponseSchema)({
        status: "success",
        data: {
          files: result.files,
          restartedAt: result.restartedAt,
          ...(result.savedAt === undefined
            ? {}
            : { savedAt: new Date(result.savedAt).toISOString() }),
          ...(result.rescue === undefined ? {} : { rescue: result.rescue }),
          ...(result.restored === undefined
            ? {}
            : { restoredName: result.restored.name }),
        },
      }),
      200,
    );
  },
);
