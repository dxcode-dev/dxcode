import type { ToolPart } from "./transcript-activity-projection.js";

/** The agent's mail tools, which read the owner's Mail. */
export const MAIL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_emails",
  "read_email",
  "wait_for_email",
]);

export const isMailToolPart = (part: ToolPart) =>
  MAIL_TOOL_NAMES.has(part.toolName);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** A dx tool's result; Claude Code mode hands it over as JSON text. */
export const mailOutputOf = (
  part: ToolPart,
): Record<string, unknown> | undefined => {
  if (typeof part.output !== "string") return record(part.output);
  try {
    return record(JSON.parse(part.output));
  } catch {
    return undefined;
  }
};

export const mailText = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** The email a read or a wait returned: the result, or its `email`. */
export const emailOf = (part: ToolPart) => {
  const output = mailOutputOf(part);
  return record(output?.email) ?? output;
};

/**
 * Where "Open in Mail" goes: the result's `mailbox_url`, only when it is
 * this app's Mail page.
 */
export const mailboxUrlOf = (part: ToolPart): string | undefined => {
  const url =
    mailText(emailOf(part)?.mailbox_url) ??
    mailText(mailOutputOf(part)?.mailbox_url);
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin &&
      parsed.pathname === "/mailbox"
      ? `${parsed.pathname}${parsed.search}`
      : undefined;
  } catch {
    return undefined;
  }
};
