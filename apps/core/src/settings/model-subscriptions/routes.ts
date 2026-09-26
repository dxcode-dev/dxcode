import {
  BeginPersonalModelSubscriptionAuthorizationResponseSchema,
  DisconnectPersonalModelSubscriptionResponseSchema,
  ListPersonalModelSubscriptionsResponseSchema,
  PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
  PersonalModelSubscriptionInUseResponseSchema,
  PersonalModelSubscriptionNotFoundResponseSchema,
  PersonalModelSubscriptionUnavailableResponseSchema,
  PollPersonalModelSubscriptionAuthorizationResponseSchema,
  RefreshPersonalModelSubscriptionResponseSchema,
} from "@dx/api";
import { Effect, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import { createAuth } from "../../auth/better-auth.js";
import {
  BrowserSessionRequired,
  requireBrowserSession,
} from "../../auth/browser-session.js";
import { loadAuthenticationRequirements } from "../../auth/requirements.js";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { loadConfigEncryptionKeyring } from "../config-encryption.js";
import { createGitHubCopilotProvider } from "./github-copilot/provider.js";
import { PersonalModelSubscriptionRepositoryD1 } from "./repository-d1.js";
import {
  PersonalModelSubscriptionConflict,
  PersonalModelSubscriptionNotFound,
  PersonalModelSubscriptionService,
  PersonalModelSubscriptionUnavailable,
} from "./service.js";

const response = (schema: Schema.ConstraintEncoder<unknown>, data: unknown) =>
  Schema.encodeUnknownSync(schema)({ status: "success", data });
const failure = (c: Context<AppEnv>, error: unknown) => {
  if (error instanceof PersonalModelSubscriptionNotFound)
    return c.json(
      Schema.encodeUnknownSync(PersonalModelSubscriptionNotFoundResponseSchema)(
        {
          status: "error",
          data: {
            code: "PERSONAL_MODEL_SUBSCRIPTION_NOT_FOUND",
            message: "Personal model subscription not found.",
            requestId: c.get("requestId"),
          },
        },
      ),
      404,
    );
  if (error instanceof BrowserSessionRequired)
    return c.json(
      Schema.encodeUnknownSync(
        PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
      )({
        status: "error",
        data: {
          code: "PERSONAL_MODEL_SUBSCRIPTION_BROWSER_SESSION_REQUIRED",
          message:
            "A browser session is required to change a personal model subscription.",
          requestId: c.get("requestId"),
        },
      }),
      403,
    );
  if (error instanceof PersonalModelSubscriptionConflict)
    return c.json(
      Schema.encodeUnknownSync(PersonalModelSubscriptionInUseResponseSchema)({
        status: "error",
        data: {
          code: "PERSONAL_MODEL_SUBSCRIPTION_IN_USE",
          message:
            "Remove this subscription from model routing before disconnecting it.",
          requestId: c.get("requestId"),
        },
      }),
      409,
    );
  return c.json(
    Schema.encodeUnknownSync(
      PersonalModelSubscriptionUnavailableResponseSchema,
    )({
      status: "error",
      data: {
        code: "PERSONAL_MODEL_SUBSCRIPTION_UNAVAILABLE",
        message: "Personal model subscriptions are temporarily unavailable.",
        requestId: c.get("requestId"),
      },
    }),
    503,
  );
};
const dependencies = async (c: Context<AppEnv>, browser: boolean) => {
  const db = await Effect.runPromise(decodeD1Binding(c.env.DB));
  const keyring = await Effect.runPromise(loadConfigEncryptionKeyring(c.env));
  let session: string | undefined;
  if (browser) {
    const requirements = await Effect.runPromise(
      loadAuthenticationRequirements(c.env),
    );
    const browserSession = await Effect.runPromise(
      Effect.result(requireBrowserSession(c, createAuth(c.env, requirements))),
    );
    if (Result.isFailure(browserSession)) throw browserSession.failure;
    session = browserSession.success.sessionId;
  }
  const clientId = c.env.DX_GITHUB_COPILOT_CLIENT_ID;
  if (!clientId?.trim()) throw new PersonalModelSubscriptionUnavailable();
  return {
    service: new PersonalModelSubscriptionService(
      new PersonalModelSubscriptionRepositoryD1(db),
      createGitHubCopilotProvider({
        clientId,
      }),
      keyring,
    ),
    session,
  };
};
const run = async (
  c: Context<AppEnv>,
  schema: Schema.ConstraintEncoder<unknown>,
  operation: () => Promise<unknown>,
) => {
  const result = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        try: operation,
        catch: (cause) =>
          cause instanceof PersonalModelSubscriptionNotFound ||
          cause instanceof PersonalModelSubscriptionConflict ||
          cause instanceof PersonalModelSubscriptionUnavailable ||
          cause instanceof BrowserSessionRequired
            ? cause
            : new PersonalModelSubscriptionUnavailable(),
      }),
    ),
  );
  return Result.isSuccess(result)
    ? c.json(response(schema, result.success), 200)
    : failure(c, result.failure);
};
const sessionOf = (value: string | undefined) => {
  if (value === undefined) throw new BrowserSessionRequired();
  return value;
};
export const personalModelSubscriptionRoutes = new Hono<AppEnv>();
personalModelSubscriptionRoutes.get("/", async (c) =>
  run(c, ListPersonalModelSubscriptionsResponseSchema, async () => ({
    connections: await (await dependencies(c, false)).service.list(
      c.get("principal").userId,
    ),
  })),
);
personalModelSubscriptionRoutes.post("/:provider/authorize", async (c) =>
  run(
    c,
    BeginPersonalModelSubscriptionAuthorizationResponseSchema,
    async () => {
      const d = await dependencies(c, true);
      return d.service.begin(
        c.get("principal").userId,
        sessionOf(d.session),
        c.req.param("provider"),
      );
    },
  ),
);
personalModelSubscriptionRoutes.post(
  "/authorization/:authorizationId/poll",
  async (c) =>
    run(
      c,
      PollPersonalModelSubscriptionAuthorizationResponseSchema,
      async () => {
        const d = await dependencies(c, true);
        return d.service.poll(
          c.get("principal").userId,
          sessionOf(d.session),
          c.req.param("authorizationId"),
        );
      },
    ),
);
personalModelSubscriptionRoutes.post(
  "/connections/:connectionId/refresh",
  async (c) =>
    run(c, RefreshPersonalModelSubscriptionResponseSchema, async () => {
      const d = await dependencies(c, true);
      return d.service.refresh(
        c.get("principal").userId,
        c.req.param("connectionId"),
      );
    }),
);
personalModelSubscriptionRoutes.delete(
  "/connections/:connectionId",
  async (c) =>
    run(c, DisconnectPersonalModelSubscriptionResponseSchema, async () => {
      const d = await dependencies(c, true);
      return d.service.disconnect(
        c.get("principal").userId,
        c.req.param("connectionId"),
      );
    }),
);
