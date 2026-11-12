import { getLogger } from "@logtape/logtape";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import {
  claimDxPrompt,
  type PendingDxPrompt,
  settleDxPrompt,
} from "../../plugins/thread-ui/store.js";

/**
 * Applying what `manage_dx` asked for, when the Thread's owner answers its
 * prompt above the composer. Each change runs inside the owner's own
 * browser request, through the same settings routes the Settings page
 * calls, so their authorization (browser session, workspace role), limits,
 * validation, and audit records are exactly the page's. The tool only
 * prepares the requests and waits for the outcome.
 *
 * A secret's value goes from the answer straight into the chosen secret
 * store: it is never written to the prompt's row, logged, or returned.
 */

const logger = getLogger(["dx", "settings", "manage-dx"]);

/** One settings request a change runs, relative to `/v1/settings`. */
export interface DxRequest {
  readonly method: "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly json?: unknown;
  /** A plugin archive, base64: sent as the ZIP request body. */
  readonly zip?: string;
}

/** What a `change` prompt's row keeps until it is applied or ends. */
export interface DxChangePlan {
  readonly topic: string;
  readonly operation: string;
  readonly requests: ReadonlyArray<DxRequest>;
}

/** What a `secret` prompt's row keeps: where its answer is stored. */
export interface DxSecretPlan {
  readonly topic: "secrets";
  readonly operation: "request";
  /** The environment variables route, such as `/personal/environment-variables`. */
  readonly path: string;
  /** Its scope query, such as `?scope=project&projectId=…`; empty for personal. */
  readonly query: string;
  readonly name: string;
  /** The create request's scope fields. */
  readonly scope: { readonly scope?: string; readonly projectId?: string };
}

/** How a dx prompt ended, as the waiting tool call reads it. */
export type DxOutcome =
  | { readonly approved: false }
  | {
      readonly approved: true;
      readonly applied: boolean;
      readonly results: ReadonlyArray<{
        readonly method: string;
        readonly path: string;
        readonly status: number;
        readonly data?: unknown;
      }>;
      readonly error?: string;
    };

let settingsRoutesModule: Promise<typeof import("../routes.js")> | undefined;

/** Settings routes, imported once and lazily: they are large. */
const settingsRoutes = () => {
  settingsRoutesModule ??= import("../routes.js");
  return settingsRoutesModule;
};

const decodeBase64 = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/** A route failure's message, with any field errors, for a person and the agent. */
const failureMessage = (status: number, payload: unknown) => {
  const data =
    typeof payload === "object" && payload !== null && "data" in payload
      ? (payload as { data?: unknown }).data
      : undefined;
  if (typeof data !== "object" || data === null)
    return `The settings request failed (${status}).`;
  const { message, detail, fieldErrors } = data as {
    message?: unknown;
    detail?: unknown;
    fieldErrors?: unknown;
  };
  const parts = [
    typeof message === "string" ? message : `Request failed (${status}).`,
  ];
  if (typeof detail === "string" && detail !== "") parts.push(detail);
  if (Array.isArray(fieldErrors))
    for (const field of fieldErrors)
      if (
        typeof field === "object" &&
        field !== null &&
        typeof (field as { message?: unknown }).message === "string"
      )
        parts.push((field as { message: string }).message);
  return parts.join(" ").slice(0, 1_000);
};

/**
 * Sends settings requests as the person answering, with their request's
 * own headers, so a route that needs a browser session sees theirs.
 */
const settingsClient = async (context: Context<AppEnv>) => {
  const { settingsRoutes: routes } = await settingsRoutes();
  const principal = context.get("principal");
  const app = new Hono<AppEnv>();
  app.use(async (inner, next) => {
    inner.set("principal", principal);
    inner.set("requestId", `${context.get("requestId")}_dx`);
    inner.set("requestStartedAt", Date.now());
    const auth = context.get("auth");
    if (auth !== undefined) inner.set("auth", auth);
    const session = context.get("authoritativeSession");
    if (session !== undefined) inner.set("authoritativeSession", session);
    await next();
  });
  app.route("/v1/settings", routes);
  const forwarded = new Headers();
  for (const name of ["cookie", "authorization", "origin", "user-agent"]) {
    const value = context.req.header(name);
    if (value !== undefined) forwarded.set(name, value);
  }
  return async (
    method: "GET" | DxRequest["method"],
    path: string,
    body?: { readonly json?: unknown; readonly zip?: Uint8Array },
  ) => {
    const headers = new Headers(forwarded);
    let payload: BodyInit | undefined;
    if (body?.zip !== undefined) {
      headers.set("content-type", "application/zip");
      payload = body.zip.slice();
    } else if (body?.json !== undefined) {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body.json);
    }
    let executionCtx: typeof context.executionCtx | undefined;
    try {
      executionCtx = context.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    const response = await app.request(
      `/v1/settings${path}`,
      { method, headers, ...(payload === undefined ? {} : { body: payload }) },
      context.env,
      executionCtx as never,
    );
    const json = (await response.json().catch(() => undefined)) as unknown;
    return { status: response.status, ok: response.ok, payload: json };
  };
};

/** The data a request returned, kept small for the agent. */
const summary = (payload: unknown) => {
  const data =
    typeof payload === "object" && payload !== null && "data" in payload
      ? (payload as { data?: unknown }).data
      : undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const { id, name, version, enabled, kind } = data as Record<string, unknown>;
  const kept = Object.fromEntries(
    Object.entries({ id, name, version, enabled, kind }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  return Object.keys(kept).length === 0 ? undefined : kept;
};

const runChange = async (context: Context<AppEnv>, plan: DxChangePlan) => {
  const send = await settingsClient(context);
  const results: Array<{
    method: string;
    path: string;
    status: number;
    data?: unknown;
  }> = [];
  for (const request of plan.requests) {
    const response = await send(request.method, request.path, {
      ...(request.json === undefined ? {} : { json: request.json }),
      ...(request.zip === undefined ? {} : { zip: decodeBase64(request.zip) }),
    });
    const data = summary(response.payload);
    results.push({
      method: request.method,
      path: request.path.split("?")[0] ?? request.path,
      status: response.status,
      ...(data === undefined ? {} : { data }),
    });
    if (!response.ok)
      return {
        approved: true,
        applied: false,
        results,
        error: failureMessage(response.status, response.payload),
      } satisfies DxOutcome;
  }
  return { approved: true, applied: true, results } satisfies DxOutcome;
};

/** Stores the secret: replaces one with the same name, or creates it. */
const storeSecret = async (
  context: Context<AppEnv>,
  plan: DxSecretPlan,
  value: string,
) => {
  const send = await settingsClient(context);
  const listed = await send("GET", `${plan.path}${plan.query}`);
  if (!listed.ok)
    return {
      approved: true,
      applied: false,
      results: [],
      error: failureMessage(listed.status, listed.payload),
    } satisfies DxOutcome;
  const items =
    (listed.payload as { data?: { items?: unknown } } | undefined)?.data
      ?.items ?? [];
  const existing = Array.isArray(items)
    ? (
        items as Array<{
          reference?: { id?: unknown };
          name?: unknown;
          kind?: unknown;
        }>
      )
        .map((item) => ({ ...item, id: item.reference?.id }))
        .find((item) => item.name === plan.name)
    : undefined;
  if (existing !== undefined && existing.kind !== "secret")
    return {
      approved: true,
      applied: false,
      results: [],
      error: `${plan.name} already exists there as a plain variable. Delete it first, or choose another name.`,
    } satisfies DxOutcome;
  const request =
    existing !== undefined && typeof existing.id === "string"
      ? {
          method: "POST" as const,
          path: `${plan.path}/${encodeURIComponent(existing.id)}/rotate${plan.query}`,
          json: { value },
        }
      : {
          method: "POST" as const,
          path: plan.path,
          json: { ...plan.scope, name: plan.name, kind: "secret", value },
        };
  const response = await send(request.method, request.path, {
    json: request.json,
  });
  const result = {
    method: request.method,
    path: request.path.split("?")[0] ?? request.path,
    status: response.status,
    data: {
      name: plan.name,
      replaced: existing !== undefined,
    },
  };
  return response.ok
    ? ({ approved: true, applied: true, results: [result] } satisfies DxOutcome)
    : ({
        approved: true,
        applied: false,
        results: [result],
        error: failureMessage(response.status, response.payload),
      } satisfies DxOutcome);
};

export class DxPromptInvalid extends Error {
  override readonly name = "DxPromptInvalid";
}

/**
 * Answers a dx prompt: `null` or `false` cancels it, `true` applies a
 * change, and text is a secret's value. Runs at most once per prompt.
 * Returns undefined when the prompt was answered or expired meanwhile.
 */
export const answerDxPrompt = async (
  context: Context<AppEnv>,
  input: {
    readonly threadId: string;
    readonly promptId: string;
    readonly userId: string;
    readonly prompt: PendingDxPrompt;
    readonly answer: unknown;
  },
): Promise<DxOutcome | undefined> => {
  const db = context.env.DB as D1Database;
  const { prompt, answer } = input;
  const plan = (prompt.plan as DxChangePlan | DxSecretPlan | null) ?? null;
  const declined = answer === null || answer === false;
  // A dx card changes settings, so only a signed-in browser applies it: an
  // API token reaches the settings routes only with its settings scope.
  if (!declined && context.get("principal").apiTokenScopes !== undefined)
    throw new DxPromptInvalid("Apply dx changes from the dx app.");
  if (!declined) {
    if (prompt.kind === "change" && answer !== true)
      throw new DxPromptInvalid("Apply a change with true.");
    if (
      prompt.kind === "secret" &&
      (typeof answer !== "string" || answer.trim() === "")
    )
      throw new DxPromptInvalid("Enter the secret's value.");
  }
  const log = {
    threadId: input.threadId,
    promptId: input.promptId,
    topic: plan?.topic,
    operation: plan?.operation,
  };
  if (declined || plan === null) {
    const outcome: DxOutcome = { approved: false };
    const settled = await settleDxPrompt(db, {
      ...input,
      outcome,
      from: "pending",
    });
    if (settled)
      logger.info("The owner cancelled a dx settings change.", {
        event: "manage_dx_declined",
        ...log,
      });
    return settled ? outcome : undefined;
  }
  if (!(await claimDxPrompt(db, input))) return undefined;
  let outcome: DxOutcome;
  try {
    outcome =
      prompt.kind === "secret"
        ? await storeSecret(context, plan as DxSecretPlan, answer as string)
        : await runChange(context, plan as DxChangePlan);
  } catch (error) {
    logger.error("A dx settings change failed to run.", {
      event: "manage_dx_apply_failed",
      ...log,
      error: error instanceof Error ? error.message : String(error),
    });
    outcome = {
      approved: true,
      applied: false,
      results: [],
      error: "dx could not apply the change. Try again shortly.",
    };
  }
  await settleDxPrompt(db, { ...input, outcome, from: "applying" });
  const level = outcome.applied ? "info" : "warn";
  logger[level]("A dx settings change ran.", {
    event: outcome.applied ? "manage_dx_applied" : "manage_dx_refused",
    ...log,
    requests: outcome.results.map(
      ({ method, path, status }) => `${method} ${path} ${status}`,
    ),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  });
  return outcome;
};
