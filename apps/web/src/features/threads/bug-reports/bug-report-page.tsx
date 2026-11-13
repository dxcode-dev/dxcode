import type { BugReportData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { PageShell } from "../../../shared/layout/page-shell.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { BugReportDialog } from "./bug-report-detail.js";
import { firstLine, reportSource, sentAt } from "./bug-report-format.js";
import { bugReportsQueryOptions } from "./bug-report-queries.js";
import "./bug-reports.css";

function ReportRow({ report }: { readonly report: BugReportData }) {
  return (
    <li>
      <Link
        className="bug-reports-row"
        to="/bug-reports/$reportId"
        params={{ reportId: report.id }}
      >
        <span className="bug-reports-row-copy">
          <strong>{firstLine(report.message)}</strong>
          <small>{sentAt(report.createdAt)}</small>
        </span>
        <span className="bug-report-status">{reportSource(report)}</span>
      </Link>
    </li>
  );
}

/**
 * Your Reports: one row per bug report the person sent. A row opens its
 * report in a dialog, and `/bug-reports/<id>` (a report's link) opens the
 * list with that report open.
 */
export function BugReportsPage({ reportId }: { readonly reportId?: string }) {
  const { identity } = useAuthenticatedIdentity();
  const reports = useQuery(bugReportsQueryOptions(identity.id));
  const navigate = useNavigate();
  return (
    <PageShell title="Your Reports" contentClassName="bug-reports-content">
      {reports.isPending ? (
        <DxLoading label="Loading your reports…" />
      ) : reports.isError ? (
        <EmptyState
          className="bug-reports-empty"
          tone="error"
          title="Your reports could not be loaded."
        />
      ) : reports.data.length === 0 ? (
        <EmptyState
          className="bug-reports-empty"
          title="No bug reports yet"
          description={
            <>Report Bug is in Settings and in a Thread's More Actions menu.</>
          }
        />
      ) : (
        <ul className="bug-reports-list">
          {reports.data.map((report) => (
            <ReportRow key={report.id} report={report} />
          ))}
        </ul>
      )}
      {reportId === undefined ? null : (
        <BugReportDialog
          key={reportId}
          reportId={reportId}
          onClose={() => void navigate({ to: "/bug-reports" })}
        />
      )}
    </PageShell>
  );
}

/** `/bug-reports`. */
export function BugReportsRoute() {
  return <BugReportsPage />;
}

/** `/bug-reports/$reportId`. */
export function BugReportRoute() {
  const { reportId } = useParams({ from: "/_product/bug-reports/$reportId" });
  return <BugReportsPage reportId={reportId} />;
}
