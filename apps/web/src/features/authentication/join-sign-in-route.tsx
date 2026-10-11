import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { workspaceInviteQueryOptions } from "../settings/members/members-queries.js";
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
      invite={
        invite.data?.status === "valid" && invite.data.workspace
          ? { path, workspace: invite.data.workspace.displayName }
          : undefined
      }
    />
  );
}
