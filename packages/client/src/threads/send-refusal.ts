import { isInputTooLargeError } from "@flue/sdk";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Core's gates refuse these before Flue sees the message. */
const CORE_REFUSALS: Readonly<Record<string, string>> = {
  THREAD_ARCHIVED: "This thread is archived. Unarchive it to send messages.",
  THREAD_READ_ONLY: "Multiplayer ended. You can still view this thread.",
  SOURCE_AUTHORIZATION_DENIED:
    "dx can't access this project's source. Check its GitHub connection.",
  SOURCE_PROVIDER_UNAVAILABLE:
    "GitHub couldn't confirm source access. Try again in a moment.",
  WORKSPACE_POLICY_DENIED:
    "Workspace policy doesn't allow this message to run.",
};

/**
 * Why the server refused a send, or `undefined` when it may have admitted
 * it: no answer arrived, the server failed, or Flue already holds another
 * submission under the key (Core rebuilds the author tag on each attempt).
 */
export const sendRefusal = (error: unknown): string | undefined => {
  if (
    !(error instanceof Error) ||
    !("status" in error) ||
    typeof error.status !== "number"
  )
    return undefined;
  const status = error.status;
  const body = "body" in error ? error.body : undefined;
  const core = field(body, "data");
  const code = text(field(core, "code"));
  if (code !== undefined && code in CORE_REFUSALS) return CORE_REFUSALS[code];
  if (status === 401) return "Your session ended. Sign in again.";
  if (isInputTooLargeError(error))
    return "The message or attachments are too large.";
  const flue = field(body, "error");
  if (status >= 500 || field(flue, "type") === "submission_conflict")
    return undefined;
  return (
    text(field(flue, "details")) ??
    text(field(flue, "message")) ??
    text(field(core, "message")) ??
    "dx refused this message."
  );
};
