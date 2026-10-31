import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  inviteCheckFailedMessage,
  inviteUnavailableMessage,
} from "../../shared/invite-unavailable.js";
import { workspaceInviteQueryOptions } from "../settings/members/members-queries.js";
import { InviteUnavailablePage } from "./invite-unavailable-page.js";
import { SignInPage } from "./sign-in-page.js";
import { signInOptionsQueryOptions } from "./sign-in-queries.js";

const joinRoute = getRouteApi("/join/$token");

/** Signed-out `/join/<token>`: sign in or create an account to accept the invite. */
export function JoinSignInRoute() {
  const { token } = joinRoute.useParams();
  const search = joinRoute.useSearch();
  const navigate = useNavigate();
  const { data: options } = useQuery(signInOptionsQueryOptions);
  const invite = useQuery(workspaceInviteQueryOptions(token));
  if (options === undefined || invite.isPending) return null;
  if (invite.isError)
    return (
      <InviteUnavailablePage
        message={inviteCheckFailedMessage}
        onRetry={() => void invite.refetch()}
      />
    );
  const workspace = invite.data.workspace;
  if (invite.data.status !== "valid" || workspace === undefined)
    return (
      <InviteUnavailablePage
        message={inviteUnavailableMessage(invite.data.status)}
      />
    );
  const path = `/join/${token}`;
  return (
    <SignInPage
      mode="sign-up"
      options={options}
      next={undefined}
      redirectError={search.error}
      onDismissRedirectError={() => {
        if (search.error !== undefined)
          void navigate({
            to: "/join/$token",
            params: { token },
            replace: true,
          });
      }}
      invite={{ path, workspace: workspace.displayName }}
    />
  );
}
