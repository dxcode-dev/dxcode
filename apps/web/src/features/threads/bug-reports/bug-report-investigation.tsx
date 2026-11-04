import type { BugReportDetail } from "@dx/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LoaderCircle, Microscope } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import { startBugReportInvestigationMutationOptions } from "./bug-report-queries.js";

/**
 * The report's one investigating Thread: Investigate starts it as this
 * person, and once it exists, Open Investigation opens it. Nothing starts
 * it but this click.
 */
export function InvestigationFooter({
  reportId,
  investigation,
}: {
  readonly reportId: string;
  readonly investigation: BugReportDetail["investigation"];
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const start = useMutation(
    startBugReportInvestigationMutationOptions(queryClient, identity.id),
  );
  if (investigation?.threadId !== undefined)
    return (
      <footer className="bug-report-investigation">
        <span>A Thread is investigating this report.</span>
        <Link
          className={buttonVariants({ variant: "outline", size: "sm" })}
          to="/threads/$threadId"
          params={{ threadId: investigation.threadId }}
        >
          <Microscope aria-hidden="true" />
          Open Investigation
        </Link>
      </footer>
    );
  if (investigation !== undefined)
    return (
      <footer className="bug-report-investigation">
        <span>Another person is investigating this report.</span>
      </footer>
    );
  return (
    <footer className="bug-report-investigation">
      {start.isError ? (
        <span className="bug-report-error" role="alert">
          {start.error instanceof Error
            ? start.error.message
            : "The investigation could not be started."}
        </span>
      ) : (
        <span>Start a Thread that investigates this report.</span>
      )}
      <Button
        size="sm"
        disabled={start.isPending}
        onClick={() =>
          start.mutate(reportId, {
            onSuccess: ({ threadId }) => {
              if (threadId !== undefined)
                void navigate({
                  to: "/threads/$threadId",
                  params: { threadId },
                });
            },
          })
        }
      >
        {start.isPending ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : (
          <Microscope aria-hidden="true" />
        )}
        Investigate
      </Button>
    </footer>
  );
}
