import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import {
  inviteCheckFailedMessage,
  inviteUnavailableMessage,
} from "../../../shared/invite-unavailable.js";
import { AppFrame } from "../../../shared/layout/app-frame.js";
import { Button } from "../../../shared/ui/button.js";
import { settingsContextQueryOptions } from "../settings-context-queries.js";
import {
  acceptInviteMutationOptions,
  workspaceInviteQueryOptions,
} from "./members-queries.js";

/** Signed-in landing for a workspace invite link. */
export function JoinWorkspacePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  const invite = useQuery(workspaceInviteQueryOptions(token));
  // The user's own workspace, to tell whether they are already in this one.
  const settings = useQuery(settingsContextQueryOptions(identity.id));
  const join = useMutation({
    ...acceptInviteMutationOptions(token),
    onSuccess: async (result) => {
      // Projects, settings, and Threads now include the workspace.
      await queryClient.invalidateQueries();
      await navigate({
        to: "/workspaces/$workspaceSlug",
        params: { workspaceSlug: result.workspace.shortName },
        replace: true,
      });
    },
  });
  const workspace = invite.data?.workspace;
  const ownWorkspace = settings.data?.workspace?.shortName;
  // A member, the owner included, has nothing to join: open the workspace.
  if (
    invite.data?.status === "valid" &&
    workspace !== undefined &&
    ownWorkspace !== undefined &&
    ownWorkspace.toLowerCase() === workspace.shortName.toLowerCase()
  )
    return (
      <Navigate
        to="/workspaces/$workspaceSlug"
        params={{ workspaceSlug: ownWorkspace }}
        replace
      />
    );
  const joinError =
    join.error instanceof Error ? join.error.message : undefined;
  return (
    <AppFrame>
      <main className="auth-gate-surface">
        <div className="auth-gate-card join-workspace-card">
          {invite.isPending || settings.isPending ? (
            <p role="status">Checking invite link…</p>
          ) : invite.isError ? (
            <p className="auth-local-error" role="alert">
              {inviteCheckFailedMessage}
            </p>
          ) : invite.data.status !== "valid" || workspace === undefined ? (
            <>
              <strong>Invite unavailable</strong>
              <p>{inviteUnavailableMessage(invite.data.status)}</p>
              <Button
                variant="outline"
                onClick={() => void navigate({ to: "/" })}
              >
                Go to dx
              </Button>
            </>
          ) : (
            <>
              <strong>Join {workspace.displayName}</strong>
              <p>
                You'll share its projects, secrets, and settings with the other
                members. Your personal threads and settings stay yours.
              </p>
              {joinError === undefined ? null : (
                <p className="auth-local-error" role="alert">
                  {joinError}
                </p>
              )}
              <Button disabled={join.isPending} onClick={() => join.mutate()}>
                {join.isPending ? "Joining…" : "Join workspace"}
              </Button>
            </>
          )}
        </div>
      </main>
    </AppFrame>
  );
}
