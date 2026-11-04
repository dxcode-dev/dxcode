import type { WorkspaceInvitePreview } from "@dx/api";

/**
 * Invite link use limits. A link without `max_uses` is unlimited. The join
 * batch inserts the member only while {@link inviteLinkHasUsesSql} holds, in
 * the same transaction that counts the use, so the limit is never exceeded.
 */
export const MAX_INVITE_LINK_USES = 1000;

/** SQL condition on a `workspace_invite_link` row that has a use left. */
export const inviteLinkHasUsesSql =
  "(max_uses IS NULL OR use_count < max_uses)";

export const isInviteLinkUsedUp = (row: {
  readonly use_count: number;
  readonly max_uses: number | null;
}) => row.max_uses !== null && row.use_count >= row.max_uses;

/** The field error for a requested use limit, if it is out of range. */
export const inviteLinkMaxUsesError = (maxUses: number | undefined) =>
  maxUses === undefined ||
  (Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= MAX_INVITE_LINK_USES)
    ? undefined
    : {
        field: "maxUses",
        message: `Choose a use limit from 1 to ${MAX_INVITE_LINK_USES}, or no limit.`,
      };

/** Why a join through a link that is not valid was refused. */
export const inviteRefusalMessage = (
  status: Exclude<WorkspaceInvitePreview["status"], "valid">,
) =>
  status === "expired"
    ? "This invite link has expired."
    : status === "revoked"
      ? "This invite link was revoked."
      : status === "used-up"
        ? "This invite link has been used up."
        : "This invite link is not valid.";
