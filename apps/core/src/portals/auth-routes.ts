// The app-origin half of the Portal sign-in handshake.
//
//   Portal host (no cookie)                   dx app origin
//   ── 302, Set-Cookie state ─────────────▶  GET /v1/portal-auth/authorize
//                                             ?thread&port&return&state
//                                             dx session? else /signin?next=…
//                                             Terminal access rule, active
//                                             store one-time code (60 s)
//   GET /__dx_portal/callback?code ◀─────── 302
//   redeem code with the state cookie,
//   Set-Cookie session, 302 to `return`
//
// The code is bound to the state cookie only the Portal host holds, so a code
// leaked from a URL is useless, and an attacker cannot sign a victim into the
// attacker's session. `return` is a path on the requested Portal, never an
// arbitrary URL.

import { ThreadId } from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { Hono } from "hono";
import { createAuth } from "../auth/better-auth.js";
import { loadAuthenticationRequirements } from "../auth/requirements.js";
import type { AppEnv } from "../http/types.js";
import { portalLogger } from "../logging.js";
import { dxSessionActive, evaluatePortalAccess } from "./access.js";
import { storePortalCode } from "./codes.js";
import { RANDOM_TOKEN, randomToken } from "./crypto.js";
import { PORTAL_CALLBACK_PATH, portalAuthorizationPage } from "./handler.js";
import {
  parsePortalPort,
  portalConfiguration,
  portalHost,
  portalOrigin,
  portalReturnPath,
} from "./host.js";
import { portalIdentityText } from "./session.js";

const invalidRequest = () =>
  portalAuthorizationPage(
    400,
    "This Portal link is invalid",
    "Open the Portal from its Thread again.",
  );

export const portalAuthRoutes = new Hono<AppEnv>().get(
  "/authorize",
  async (context) => {
    const configuration = portalConfiguration(context.env);
    if (configuration === undefined) return context.notFound();
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.query("thread"),
    );
    const port = parsePortalPort(context.req.query("port"));
    const path = portalReturnPath(context.req.query("return"));
    const state = context.req.query("state");
    if (
      Option.isNone(threadId) ||
      port === undefined ||
      path === undefined ||
      state === undefined ||
      !RANDOM_TOKEN.test(state)
    )
      return invalidRequest();

    const requirements = await Effect.runPromise(
      loadAuthenticationRequirements(context.env),
    );
    // Uncached: a session revoked within Better Auth's cookie cache window
    // must not mint a code.
    const session = await createAuth(context.env, requirements).api.getSession({
      headers: context.req.raw.headers,
      query: { disableCookieCache: true },
    });
    if (
      session === null ||
      !(await dxSessionActive(
        context.env.DB as D1Database,
        session.session.id,
        session.user.id,
        Date.now(),
      ))
    ) {
      const self = new URL(context.req.url);
      const signIn = new URL("/signin", configuration.appOrigin);
      signIn.searchParams.set("next", `${self.pathname}${self.search}`);
      return context.redirect(signIn.href, 302);
    }

    const access = await evaluatePortalAccess(
      context.env.DB,
      session.user.id,
      threadId.value,
    );
    portalLogger.info("Portal authorization evaluated.", {
      event: "portal_authorization_completed",
      requestId: context.get("requestId"),
      threadId: threadId.value,
      port,
      outcome: access,
    });
    if (access === "not-found")
      return portalAuthorizationPage(
        404,
        "Thread not found",
        "This Portal's Thread does not exist, or you do not have access to it.",
      );
    if (access === "read-only")
      return portalAuthorizationPage(
        403,
        "You can view this Thread",
        "Opening its Portals needs Contribute access. Ask its owner.",
      );
    if (access === "archived")
      return portalAuthorizationPage(
        409,
        "This Thread is archived",
        "Unarchive the Thread to open its Portals.",
      );

    const code = randomToken();
    await storePortalCode(
      context.env.DB as D1Database,
      code,
      state,
      {
        portalHost: portalHost(configuration, threadId.value, port),
        userId: session.user.id,
        sessionId: session.session.id,
        ...portalIdentityText(session.user.email, session.user.name),
        returnPath: path,
      },
      Date.now(),
    );
    const callback = new URL(
      PORTAL_CALLBACK_PATH,
      portalOrigin(configuration, threadId.value, port),
    );
    callback.searchParams.set("code", code);
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    return context.redirect(callback.href, 302);
  },
);
