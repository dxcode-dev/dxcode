import { ApiError } from "../../shared/api/client.js";

/** The deployment has no RealtimeKit app, so a link cannot open a huddle. */
export class HuddlesOffError extends Error {
  constructor() {
    super("Huddles are not available on this dx.");
    this.name = "HuddlesOffError";
  }
}

/** Why a huddle link did not open, for its page. */
export const huddleLinkFailure = (
  error: unknown,
):
  | "off"
  | "HUDDLE_LINK_NOT_FOUND"
  | "HUDDLE_LINK_FORBIDDEN"
  | "HUDDLE_PRIVATE"
  | undefined => {
  if (error instanceof HuddlesOffError) return "off";
  const code = error instanceof ApiError ? error.code : undefined;
  return code === "HUDDLE_LINK_NOT_FOUND" ||
    code === "HUDDLE_LINK_FORBIDDEN" ||
    code === "HUDDLE_PRIVATE"
    ? code
    : undefined;
};
