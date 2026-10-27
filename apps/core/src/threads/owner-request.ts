import type { Principal, UserId } from "@dx/domain";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";

let ownerRouteModules:
  | Promise<
      [
        typeof import("./routes.js"),
        typeof import("../agents/routes.js"),
        typeof import("../settings/routes.js"),
      ]
    >
  | undefined;

/**
 * The routes called as a Thread owner, imported once and lazily: they import
 * DxAgent, which mounts the tools that call them.
 */
const ownerRoutes = () => {
  ownerRouteModules ??= Promise.all([
    import("./routes.js"),
    import("../agents/routes.js"),
    import("../settings/routes.js"),
  ]);
  return ownerRouteModules;
};

export interface OwnerRequestContext {
  readonly bindings: Bindings;
  readonly ownerUserId: UserId;
  /** The Thread whose agent sends any message this request delivers. */
  readonly sourceThreadId?: string;
  /** The schedule or GitHub subscription delivering this request's message. */
  readonly automation?: "schedule" | "github";
  /** Keeps work a route starts, such as title generation, running. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Calls the routes the web client uses, as the Thread owner signed in to the
 * browser: the Thread routes, DxAgent's routes, and settings, with the same
 * authorization, admission, policy, and realtime updates.
 */
export const ownerRequest = async (
  context: OwnerRequestContext,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) => {
  const [{ threadRoutes }, { dxAgentRoutes }, { settingsRoutes }] =
    await ownerRoutes();
  const app = new Hono<AppEnv>();
  app.use(async (honoContext, next) => {
    honoContext.set("principal", {
      userId: context.ownerUserId,
      credentialScopes: ["personal", "workspace"],
    } satisfies Principal);
    honoContext.set("requestId", `thread_tool_${crypto.randomUUID()}`);
    honoContext.set("requestStartedAt", Date.now());
    if (context.sourceThreadId !== undefined)
      honoContext.set("messageSourceThreadId", context.sourceThreadId);
    if (context.automation !== undefined)
      honoContext.set("messageAutomation", context.automation);
    await next();
  });
  app.route("/v1/threads", threadRoutes);
  app.route("/v1/agents/dx", dxAgentRoutes);
  app.route("/v1/settings", settingsRoutes);
  const response = await app.request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    context.bindings,
    {
      // Title generation and realtime updates outlive the response.
      waitUntil: (promise: Promise<unknown>) => {
        const settled = promise.catch(() => undefined);
        context.waitUntil?.(settled);
      },
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext,
  );
  const payload = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  return { response, payload };
};
