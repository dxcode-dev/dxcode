import { HuddleErrorResponseSchema, type HuddleFailure } from "@dx/api";
import { Schema } from "effect";
import type { Context } from "hono";
import type { AppEnv } from "../http/types.js";

const FAILURES = {
  HUDDLE_PRIVATE: [
    409,
    "Huddles are only in shared threads and Spaces. Share this one with your workspace first.",
  ],
  HUDDLE_LINK_NOT_FOUND: [
    404,
    "This huddle link doesn't exist. Check the code and the workspace name.",
  ],
  HUDDLE_LINK_FORBIDDEN: [
    403,
    "You don't have access to this huddle. Ask whoever sent the link to share the thread with your workspace.",
  ],
  HUDDLE_UNAVAILABLE: [
    409,
    "This deployment has no RealtimeKit app, so huddles are unavailable.",
  ],
  HUDDLE_PROVIDER_FAILED: [
    502,
    "RealtimeKit did not answer. Try again in a moment.",
  ],
} as const satisfies Record<HuddleFailure, readonly [number, string]>;

export const failure = (context: Context<AppEnv>, code: HuddleFailure) => {
  const [status, message] = FAILURES[code];
  return context.json(
    Schema.encodeUnknownSync(HuddleErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );
};
