import type { Principal } from "@dx/domain";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import { sha256Hex } from "../threads/agent-tools.js";
import { spacesEnabledFor, threadOwner } from "./gate.js";

/**
 * Sends a message to a Space's agent through DxAgent's routes behind dx's
 * admission, signed in as `actor`: authorization finds their access to the
 * Space, the author tag names them, and `attributeSubmission` makes it a
 * post, a comment, or the setup message as `variables` say. Posts, `@dx`
 * comments, and a new Space's setup message all arrive this way.
 */
export interface SpaceAgentDelivery {
  readonly actor: Principal;
  readonly threadId: string;
  readonly body: string;
  /** Hashed into the delivery's idempotency key. */
  readonly key: string;
  readonly variables?: {
    readonly messageCommentOn?: string;
    readonly spacePost?: AppEnv["Variables"]["spacePost"];
    readonly spaceSetup?: true;
  };
  /** Creates the Space's agent when it has none yet. */
  readonly initialData?: unknown;
}

export type DeliverToSpaceAgent = (
  delivery: SpaceAgentDelivery,
) => Promise<{ readonly status: number; readonly submissionId?: string }>;

export const deliverToSpaceAgent =
  (
    bindings: Bindings,
    waitUntil?: (promise: Promise<unknown>) => void,
  ): DeliverToSpaceAgent =>
  async (input) => {
    // A Space whose owner turned Spaces off has no agent to deliver to: its
    // prompt and tools never load (spaces/gate.ts), so the post is refused
    // and nothing is stored.
    const owner =
      bindings.DB === undefined
        ? undefined
        : await threadOwner(bindings.DB, input.threadId);
    if (owner === undefined || !(await spacesEnabledFor(bindings, owner)))
      return { status: 503 };
    const { dxAgentRoutes } = await import("../agents/routes.js");
    const app = new Hono<AppEnv>();
    app.use(async (context, next) => {
      context.set("principal", input.actor);
      context.set("requestId", `space_agent_${crypto.randomUUID()}`);
      context.set("requestStartedAt", Date.now());
      const variables = input.variables ?? {};
      if (variables.messageCommentOn !== undefined)
        context.set("messageCommentOn", variables.messageCommentOn);
      if (variables.spacePost !== undefined)
        context.set("spacePost", variables.spacePost);
      if (variables.spaceSetup === true) context.set("spaceSetup", true);
      await next();
    });
    app.route("/v1/agents/dx", dxAgentRoutes);
    const response = await app.request(
      `/v1/agents/dx/${encodeURIComponent(input.threadId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "user",
          body: input.body,
          idempotencyKey: await sha256Hex(input.key),
          ...(input.initialData === undefined
            ? {}
            : { initialData: input.initialData }),
        }),
      },
      bindings,
      {
        waitUntil: (promise: Promise<unknown>) => {
          const settled = promise.catch(() => undefined);
          waitUntil?.(settled);
        },
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext,
    );
    const payload = (await response.json().catch(() => undefined)) as
      | { readonly submissionId?: unknown }
      | undefined;
    return {
      status: response.status,
      ...(typeof payload?.submissionId === "string"
        ? { submissionId: payload.submissionId }
        : {}),
    };
  };
