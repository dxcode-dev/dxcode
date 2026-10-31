import type { WorkspaceInviteStatus } from "@dx/api";

const unavailableMessage = {
  expired: "This invite link has expired. Ask a workspace admin for a new one.",
  revoked: "This invite link was revoked. Ask a workspace admin for a new one.",
  "not-found": "This invite link is not valid.",
} as const;

/**
 * Why an invite link cannot be used, shown alike to signed-in and signed-out
 * visitors. A `valid` status without a workspace counts as not found.
 */
export const inviteUnavailableMessage = (status: WorkspaceInviteStatus) =>
  unavailableMessage[status === "valid" ? "not-found" : status];

export const inviteCheckFailedMessage =
  "The invite link could not be checked. Try again.";
