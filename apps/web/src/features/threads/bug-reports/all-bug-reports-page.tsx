import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { PageShell } from "../../../shared/layout/page-shell.js";
import { Button } from "../../../shared/ui/button.js";
import { BugReportDialog } from "./bug-report-detail.js";
import { firstLine, reportSource, sentAt } from "./bug-report-format.js";
import {
  allBugReportsQueryOptions,
  bugReportAccessQueryOptions,
} from "./bug-report-queries.js";
import "./bug-reports.css";

/**
 * All Bug Reports: every report this deployment keeps, newest first, for
 * the report readers its deploy names. A row opens the report in a dialog
 * at `/bug-reports/all/<id>`. Everyone else finds nothing here.
 */
export function AllBugReportsPage({
  reportId,
}: {
  readonly reportId?: string;
}) {
  const { identity } = useAuthenticatedIdentity();
  const access = useQuery(bugReportAccessQueryOptions(identity.id));
  const reports = useInfiniteQuery({
    ...allBugReportsQueryOptions(identity.id),
    enabled: access.data === true,
  });
  const navigate = useNavigate();
  const items = reports.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <PageShell title="All Bug Reports" contentClassName="bug-reports-content">
      {access.isPending || (access.data === true && reports.isPending) ? (
        <DxLoading label="Loading bug reports…" />
      ) : access.data !== true ? (
        <div className="empty-state bug-reports-empty">
          <strong>
            Only this deployment's report readers see every report.
          </strong>
          <Link to="/bug-reports">Your Reports</Link>
        </div>
      ) : reports.isError ? (
        <div className="empty-state bug-reports-empty">
          <strong>Bug reports could not be loaded.</strong>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state bug-reports-empty">
          <strong>No bug reports yet</strong>
        </div>
      ) : (
        <>
          <ul className="bug-reports-list">
            {items.map((report) => (
              <li key={report.id}>
                <Link
                  className="bug-reports-row"
                  to="/bug-reports/all/$reportId"
                  params={{ reportId: report.id }}
                >
                  <span className="bug-reports-row-copy">
                    <strong>{firstLine(report.message)}</strong>
                    <small>
                      {report.reporter.you ? "You" : report.reporter.name}
                      {" · "}
                      {sentAt(report.createdAt)}
                    </small>
                  </span>
                  <span className="bug-report-status">
                    {reportSource(report)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {reports.hasNextPage ? (
            <div className="bug-reports-more">
              <Button
                size="sm"
                variant="outline"
                disabled={reports.isFetchingNextPage}
                onClick={() => void reports.fetchNextPage()}
              >
                {reports.isFetchingNextPage ? "Loading…" : "Load More"}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {reportId === undefined ? null : (
        <BugReportDialog
          key={reportId}
          reportId={reportId}
          onClose={() => void navigate({ to: "/bug-reports/all" })}
        />
      )}
    </PageShell>
  );
}

/** `/bug-reports/all`. */
export function AllBugReportsRoute() {
  return <AllBugReportsPage />;
}

/** `/bug-reports/all/$reportId`. */
export function AllBugReportRoute() {
  const { reportId } = useParams({
    from: "/_product/bug-reports/all/$reportId",
  });
  return <AllBugReportsPage reportId={reportId} />;
}
