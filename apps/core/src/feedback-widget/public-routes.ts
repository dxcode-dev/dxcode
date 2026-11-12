// The Feedback Widget's public routes, under /api/feedback-widget, which
// Workers run before static assets on every host.
//
//   website (allowed origin)        dx origin
//   <script src=/<id>.js> ───────▶ widget script (inert when off)
//   Send: <iframe /<id>/panel> ───▶ panel; frame-ancestors = allowed origins
//     postMessage(comments) ─────▶ panel checks the sender is allowed
//   Continue with dx:              popup GET /<id>/authorize?challenge
//                                   dx session? else /signin?next=…
//                                   consent → POST → consent recorded
//   panel POST /<id>/token {verifier}: sha256(verifier) = challenge → grant
//   panel GET /<id>/me, POST /<id>/threads with the grant as a bearer token
//
// The grant lives only in the panel's storage, which the browser partitions
// by the website framing it; the website never sees it. A challenge seen in
// the popup's address is useless without the verifier the panel keeps.

import { FeedbackWidgetSendRequestSchema } from "@dx/api";
import {
  type ExperimentalFeatureId,
  FEEDBACK_WIDGET_FEATURE,
  FeedbackWidgetClientId,
  newThreadId,
  type Principal,
  type ProjectId,
  type UserId,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { createAuth } from "../auth/better-auth.js";
import { loadAuthenticationRequirements } from "../auth/requirements.js";
import {
  readBoundedFormData,
  readBoundedJson,
  readBoundedText,
} from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { feedbackWidgetLogger } from "../logging.js";
import { experimentalFeatureEnabled } from "../settings/experimental-features/routes.js";
import { ownerRequest } from "../threads/owner-request.js";
import {
  approvedPage,
  consentPage,
  messagePage,
  panelPage,
  widgetScript,
} from "./pages.js";
import { appOrigin, reachableProject } from "./settings-routes.js";
import {
  type ClientWidget,
  claimAuthorization,
  deleteGrant,
  type GrantHolder,
  readClientWidget,
  readGrant,
  recordAuthorization,
  sha256Hex,
} from "./store.js";
import { feedbackThreadPrompt, feedbackThreadTitle } from "./thread-prompt.js";

const CHALLENGE = /^[0-9a-f]{64}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_SEND_BYTES = 128 * 1024;
// The consent form and the token exchange carry a short challenge or verifier.
const MAX_SMALL_FORM_BYTES = 16 * 1024;

const clientIdOf = (value: string | undefined) =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(FeedbackWidgetClientId)(value),
  );

const widgetFor = async (context: Context<AppEnv>) => {
  const clientId = clientIdOf(context.req.param("clientId"));
  return clientId === undefined
    ? undefined
    : readClientWidget(context.env.DB as D1Database, clientId);
};

const apiError = (
  context: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503,
  code: string,
  message: string,
) =>
  context.json(
    {
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    },
    status,
    { "cache-control": "no-store" },
  );

const personal = (userId: string): Principal => ({
  userId: userId as UserId,
  credentialScopes: ["personal", "workspace"],
});

const featureEnabled = (bindings: AppEnv["Bindings"], userId: string) =>
  experimentalFeatureEnabled(
    bindings,
    personal(userId),
    FEEDBACK_WIDGET_FEATURE as ExperimentalFeatureId,
  ).catch(() => false);

type Readiness = "ready" | "feature-disabled" | "access-required";

/** Whether this person may send from this widget now. */
const readiness = async (
  bindings: AppEnv["Bindings"],
  widget: ClientWidget,
  userId: string,
): Promise<Readiness> => {
  const [enabled, project] = await Promise.all([
    featureEnabled(bindings, userId),
    reachableProject(
      bindings.DB as D1Database,
      personal(userId),
      widget.projectId as ProjectId,
    ),
  ]);
  if (project === undefined) return "access-required";
  return enabled ? "ready" : "feature-disabled";
};

const bearer = (context: Context<AppEnv>) => {
  const header = context.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
};

const withGrant =
  (
    handle: (
      context: Context<AppEnv>,
      widget: ClientWidget,
      holder: GrantHolder,
      token: string,
    ) => Promise<Response>,
  ) =>
  async (context: Context<AppEnv>) => {
    const widget = await widgetFor(context);
    if (widget === undefined)
      return apiError(
        context,
        404,
        "FEEDBACK_WIDGET_NOT_FOUND",
        "This Feedback Widget is turned off.",
      );
    const token = bearer(context);
    const holder =
      token === undefined
        ? undefined
        : await readGrant(context.env.DB as D1Database, widget, token);
    if (token === undefined || holder === undefined)
      return apiError(
        context,
        401,
        "FEEDBACK_WIDGET_SIGN_IN_REQUIRED",
        "Continue with dx to send.",
      );
    return handle(context, widget, holder, token);
  };

const session = async (context: Context<AppEnv>) => {
  const requirements = await Effect.runPromise(
    loadAuthenticationRequirements(context.env),
  );
  // Uncached: a session ended elsewhere must not consent.
  return createAuth(context.env, requirements).api.getSession({
    headers: context.req.raw.headers,
    query: { disableCookieCache: true },
  });
};

export const feedbackWidgetPublicRoutes = new Hono<AppEnv>()
  .get("/:script", async (context) => {
    const match = /^(.+)\.js$/.exec(context.req.param("script"));
    const clientId = clientIdOf(match?.[1]);
    if (clientId === undefined) return context.notFound();
    const widget = await readClientWidget(
      context.env.DB as D1Database,
      clientId,
    );
    return widgetScript(
      widget === undefined
        ? undefined
        : {
            clientId,
            appOrigin: await appOrigin(context.env),
            allowedOrigins: widget.origins,
          },
    );
  })
  .get("/:clientId/panel", async (context) => {
    const widget = await widgetFor(context);
    if (widget === undefined)
      return messagePage(
        404,
        "Feedback Widget is off",
        "This Project's Feedback Widget is turned off.",
      );
    return panelPage({
      clientId: widget.clientId,
      appOrigin: await appOrigin(context.env),
      projectLabel: widget.projectLabel,
      allowedOrigins: widget.origins,
    });
  })
  .get("/:clientId/authorize", async (context) => {
    const widget = await widgetFor(context);
    const challenge = context.req.query("challenge") ?? "";
    if (widget === undefined || !CHALLENGE.test(challenge))
      return messagePage(
        400,
        "This sign-in link is invalid",
        "Close this window and choose Continue with dx in the widget again.",
      );
    const current = await session(context);
    if (current === null) {
      const self = new URL(context.req.url);
      const signIn = new URL("/signin", await appOrigin(context.env));
      signIn.searchParams.set("next", `${self.pathname}${self.search}`);
      return context.redirect(signIn.href, 302);
    }
    const ready = await readiness(context.env, widget, current.user.id);
    if (ready === "access-required")
      return messagePage(
        403,
        "Access Required",
        `You can't start Threads in ${widget.projectLabel}. Ask its owner to add you to the workspace.`,
      );
    if (ready === "feature-disabled")
      return messagePage(
        403,
        "Turn on Feedback Widget",
        "Turn on Feedback Widget in Personal Settings → Experimental Features, then choose Continue with dx again.",
      );
    return consentPage({
      projectLabel: widget.projectLabel,
      userLabel: current.user.email || current.user.name,
      challenge,
      action: `/api/feedback-widget/${widget.clientId}/authorize`,
    });
  })
  .post("/:clientId/authorize", async (context) => {
    const origin = await appOrigin(context.env);
    // The consent form posts from this origin; nothing else may record one.
    // Browsers set Sec-Fetch-Site themselves, so a page cannot forge it.
    if (
      context.req.header("origin") !== origin &&
      context.req.header("sec-fetch-site") !== "same-origin"
    )
      return messagePage(
        403,
        "Sign-in refused",
        "Close this window and choose Continue with dx in the widget again.",
      );
    const widget = await widgetFor(context);
    const form = await readBoundedFormData(
      context.req.raw,
      MAX_SMALL_FORM_BYTES,
    ).catch(() => undefined);
    const challenge = form?.get("challenge");
    if (
      widget === undefined ||
      typeof challenge !== "string" ||
      !CHALLENGE.test(challenge)
    )
      return messagePage(
        400,
        "This sign-in link is invalid",
        "Close this window and choose Continue with dx in the widget again.",
      );
    const current = await session(context);
    if (current === null)
      return messagePage(
        401,
        "Sign in again",
        "Your dx session ended. Close this window and choose Continue with dx again.",
      );
    if ((await readiness(context.env, widget, current.user.id)) !== "ready")
      return messagePage(
        403,
        "Access Required",
        `You can't start Threads in ${widget.projectLabel}.`,
      );
    await recordAuthorization(context.env.DB as D1Database, {
      challenge,
      clientId: widget.clientId,
      userId: current.user.id,
    });
    feedbackWidgetLogger.info("Feedback Widget consent recorded.", {
      event: "feedback_widget_consent",
      projectId: widget.projectId,
      userId: current.user.id,
      requestId: context.get("requestId"),
    });
    return approvedPage(origin);
  })
  .post("/:clientId/token", async (context) => {
    const widget = await widgetFor(context);
    if (widget === undefined)
      return apiError(
        context,
        404,
        "FEEDBACK_WIDGET_NOT_FOUND",
        "This Feedback Widget is turned off.",
      );
    const body = (await readBoundedJson(
      context.req.raw,
      MAX_SMALL_FORM_BYTES,
    ).catch(() => undefined)) as { verifier?: unknown } | undefined;
    const verifier = body?.verifier;
    if (typeof verifier !== "string" || !VERIFIER.test(verifier))
      return apiError(context, 400, "INVALID_REQUEST", "Invalid verifier.");
    const claimed = await claimAuthorization(context.env.DB as D1Database, {
      challenge: await sha256Hex(verifier),
      widget,
    });
    // Not an error: the person has not chosen Allow yet.
    if (claimed === undefined)
      return context.json(
        {
          status: "pending",
          data: {
            code: "FEEDBACK_WIDGET_AUTHORIZATION_PENDING",
            message:
              "Waiting for you to allow the widget in the sign-in window.",
          },
        },
        202,
        { "cache-control": "no-store" },
      );
    return context.json(
      { status: "success", data: { token: claimed.token } },
      200,
      { "cache-control": "no-store" },
    );
  })
  .get(
    "/:clientId/me",
    withGrant(async (context, widget, holder) =>
      context.json(
        {
          status: "success",
          data: {
            name: holder.name,
            email: holder.email,
            projectLabel: widget.projectLabel,
            readiness: await readiness(context.env, widget, holder.userId),
          },
        },
        200,
        { "cache-control": "no-store" },
      ),
    ),
  )
  .post(
    "/:clientId/sign-out",
    withGrant(async (context, _widget, _holder, token) => {
      await deleteGrant(context.env.DB as D1Database, token);
      return context.json({ status: "success", data: {} }, 200);
    }),
  )
  .post(
    "/:clientId/threads",
    withGrant(async (context, widget, holder) => {
      // A dropped upload reads as empty, which fails validation as before.
      const text = await readBoundedText(context.req.raw, MAX_SEND_BYTES).catch(
        () => "",
      );
      if (text === undefined)
        return apiError(
          context,
          413,
          "PAYLOAD_TOO_LARGE",
          "Too many comments.",
        );
      const decoded = Schema.decodeUnknownOption(
        FeedbackWidgetSendRequestSchema,
      )(
        (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return undefined;
          }
        })(),
      );
      if (Option.isNone(decoded))
        return apiError(
          context,
          400,
          "INVALID_REQUEST",
          "Request validation failed.",
        );
      const comments = decoded.value.comments;
      const refused = comments.find((comment) => {
        try {
          return !widget.origins.includes(new URL(comment.pageUrl).origin);
        } catch {
          return true;
        }
      });
      if (refused !== undefined)
        return apiError(
          context,
          403,
          "FEEDBACK_WIDGET_ORIGIN_NOT_ALLOWED",
          "A comment's page is not on an allowed origin for this Project.",
        );
      const ready = await readiness(context.env, widget, holder.userId);
      if (ready === "access-required")
        return apiError(
          context,
          403,
          "FEEDBACK_WIDGET_ACCESS_REQUIRED",
          `You can't start Threads in ${widget.projectLabel}.`,
        );
      if (ready === "feature-disabled")
        return apiError(
          context,
          403,
          "FEEDBACK_WIDGET_FEATURE_DISABLED",
          "Turn on Feedback Widget in Experimental Features.",
        );
      const threadId = newThreadId();
      const { response, payload } = await ownerRequest(
        {
          bindings: context.env,
          ownerUserId: holder.userId as UserId,
          // A visitor's text, not the owner's: tools that act only on the
          // owner's own word (manage_dx) refuse it.
          automation: "external",
          waitUntil: (promise) => context.executionCtx.waitUntil(promise),
        },
        "POST",
        "/v1/threads",
        {
          threadId,
          projectId: widget.projectId,
          title: feedbackThreadTitle(comments),
          generateTitle: false,
          initialMessage: {
            body: feedbackThreadPrompt(comments),
            attachments: [],
          },
        },
      );
      const created = (payload?.data as { id?: unknown } | undefined)?.id;
      if (!response.ok || created !== threadId) {
        const failure = payload?.data as
          | { code?: string; message?: string }
          | undefined;
        feedbackWidgetLogger.warn("Feedback Widget could not start a Thread.", {
          event: "feedback_widget_send_failed",
          projectId: widget.projectId,
          userId: holder.userId,
          status: response.status,
          code: failure?.code,
          requestId: context.get("requestId"),
        });
        return apiError(
          context,
          response.status === 503 ? 503 : 422,
          failure?.code ?? "THREAD_NOT_STARTED",
          failure?.message ?? "dx could not start the Thread.",
        );
      }
      feedbackWidgetLogger.info("Feedback Widget started a Thread.", {
        event: "feedback_widget_send",
        projectId: widget.projectId,
        userId: holder.userId,
        threadId,
        comments: comments.length,
        requestId: context.get("requestId"),
      });
      return context.json(
        {
          status: "success",
          data: {
            threadId,
            threadUrl: `${await appOrigin(context.env)}/threads/${threadId}`,
          },
        },
        201,
        { "cache-control": "no-store" },
      );
    }),
  );
