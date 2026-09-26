import { BrowserSessionId } from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import type { Context } from "hono";
import type { AppEnv } from "../http/types.js";
import type { DxAuth } from "./better-auth.js";

export class BrowserSessionRequired extends Schema.TaggedError<BrowserSessionRequired>()(
  "BrowserSessionRequired",
  {},
) {}

export const requireBrowserSession = Effect.fn("requireBrowserSession")(
  function* (context: Context<AppEnv>, auth: DxAuth) {
    if (context.get("principal").apiTokenScopes !== undefined) {
      return yield* new BrowserSessionRequired();
    }
    const session = yield* Effect.tryPromise({
      try: () =>
        auth.api.getSession({
          headers: context.req.raw.headers,
          query: { disableCookieCache: true },
        }),
      catch: () => new BrowserSessionRequired(),
    });
    if (
      session === null ||
      session.user.id !== context.get("principal").userId
    ) {
      return yield* new BrowserSessionRequired();
    }
    const sessionId = Schema.decodeOption(BrowserSessionId)(session.session.id);
    if (Option.isNone(sessionId)) return yield* new BrowserSessionRequired();
    return { session, sessionId: sessionId.value };
  },
);
