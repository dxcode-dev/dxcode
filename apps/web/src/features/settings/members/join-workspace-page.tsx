import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AppFrame } from "../../../shared/layout/app-frame.js";
import { Button } from "../../../shared/ui/button.js";
import {
  acceptInviteMutationOptions,
  workspaceInviteQueryOptions,
} from "./members-queries.js";

const invalidMessage = {
  expired: "This invite link has expired. Ask a workspace admin for a new one.",
  revoked: "This invite link was revoked. Ask a workspace admin for a new one.",
  "not-found": "This invite link is not valid.",
} as const;

/** Signed-in landing for a workspace invite link. */
export function JoinWorkspacePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invite = useQuery(workspaceInviteQueryOptions(token));
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
  const joinError =
    join.error instanceof Error ? join.error.message : undefined;
  return (
    <AppFrame>
      <main className="auth-gate-surface">
        <div className="auth-gate-card join-workspace-card">
          {invite.isPending ? (
            <p role="status">Checking invite link…</p>
          ) : invite.isError ? (
            <p className="auth-local-error" role="alert">
              The invite link could not be checked. Try again.
            </p>
          ) : invite.data.status !== "valid" || workspace === undefined ? (
            <>
              <strong>Invite unavailable</strong>
              <p>
                {
                  invalidMessage[
                    invite.data.status === "valid"
                      ? "not-found"
                      : invite.data.status
                  ]
                }
              </p>
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
