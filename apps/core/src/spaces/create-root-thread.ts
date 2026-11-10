import type {
  Principal,
  ProjectId,
  ThreadId,
  ThreadModelSelection,
} from "@dx/domain";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";

let threadRouteModule:
  | Promise<typeof import("../threads/routes.js")>
  | undefined;

/**
 * The Thread routes, imported lazily: they import DxAgent, whose prompt reads
 * Spaces.
 */
const threadRoutes = async () => {
  threadRouteModule ??= import("../threads/routes.js");
  return (await threadRouteModule).threadRoutes;
};

/** Runs work after the response, or drops it where there is no context. */
const executionOf = (context: Context<AppEnv>) => {
  try {
    return context.executionCtx;
  } catch {
    return undefined;
  }
};

/**
 * Creates a Space's root Thread through `POST /v1/threads`, as the person
 * creating the Space, so it passes the same Project, policy, source, and Orb
 * checks as any Thread and records `kind = 'space'` with its row. It runs in
 * executor mode (no Orb) on the route `resolveSpaceAgentRoute` picked:
 * Claude Code bound to a plan, or a model through Model Routing. No first
 * message: the Space's agent starts when someone writes in it.
 */
export const createSpaceRootThread = async (
  context: Context<AppEnv>,
  principal: Principal,
  input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly selection: ThreadModelSelection;
    readonly claudeConnectionId?: string;
  },
): Promise<
  | { readonly ok: true; readonly threadId: ThreadId }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string | undefined;
    }
> => {
  const routes = await threadRoutes();
  const app = new Hono<AppEnv>();
  app.use(async (inner, next) => {
    inner.set("principal", principal);
    inner.set("requestId", context.get("requestId"));
    inner.set("requestStartedAt", Date.now());
    inner.set("threadCreation", { kind: "space", executionMode: "executor" });
    await next();
  });
  app.route("/v1/threads", routes);
  const execution = executionOf(context);
  const response = await app.request(
    "/v1/threads",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: input.projectId,
        title: input.name,
        generateTitle: false,
        selection: input.selection,
        ...(input.claudeConnectionId === undefined
          ? {}
          : { claudeConnectionId: input.claudeConnectionId }),
      }),
    },
    context.env,
    {
      waitUntil: (promise: Promise<unknown>) =>
        execution?.waitUntil(promise.catch(() => undefined)),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext,
  );
  const payload = (await response.json().catch(() => undefined)) as
    | {
        readonly data?: { readonly id?: string; readonly code?: string };
      }
    | undefined;
  if (response.ok && typeof payload?.data?.id === "string")
    return { ok: true, threadId: payload.data.id as ThreadId };
  return { ok: false, status: response.status, code: payload?.data?.code };
};
