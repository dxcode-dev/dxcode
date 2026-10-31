import type { BugReportData } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { FileJson } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { PageShell } from "../../../shared/layout/page-shell.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { firstLine, statusText } from "./bug-report-format.js";
import {
  bugReportFileUrl,
  bugReportQueryOptions,
  bugReportsQueryOptions,
} from "./bug-report-queries.js";
import { ReportStatus } from "./bug-report-status.js";
import "./bug-reports.css";

const DIAGNOSTIC_LABELS = {
  "thread-and-app": "Thread and App Diagnostics",
  changes: "Diff Diagnostics",
  dictation: "Dictation Diagnostics",
} as const;

const sentAt = (createdAt: string) =>
  new Date(createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** One report, opened from its row: what was sent and where it went. */
function BugReportDialog({
  reportId,
  onClose,
}: {
  readonly reportId: string;
  readonly onClose: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const detail = useQuery(bugReportQueryOptions(identity.id, reportId));
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="bug-report-detail">
        {detail.isPending ? (
          <>
            <DialogTitle>Bug Report</DialogTitle>
            <DxLoading label="Loading the report…" />
          </>
        ) : detail.isError ? (
          <>
            <DialogTitle>Bug report not found</DialogTitle>
            <p>It does not exist, or only its reporter can open it.</p>
          </>
        ) : (
          <>
            <DialogTitle>{firstLine(detail.data.report.message)}</DialogTitle>
            <dl className="bug-report-facts">
              <dt>Status</dt>
              <dd>
                <ReportStatus report={detail.data.report} />
              </dd>
              <dt>Sent</dt>
              <dd>
                <time dateTime={detail.data.report.createdAt}>
                  {sentAt(detail.data.report.createdAt)}
                </time>
              </dd>
              <dt>Thread</dt>
              <dd>
                <Link
                  to="/threads/$threadId"
                  params={{ threadId: detail.data.report.threadId }}
                >
                  {detail.data.report.threadId}
                </Link>
              </dd>
              <dt>Diagnostics</dt>
              <dd>
                {detail.data.report.diagnostics.length === 0
                  ? "None"
                  : detail.data.report.diagnostics
                      .map((kind) => DIAGNOSTIC_LABELS[kind])
                      .join(", ")}
                {detail.data.files.flatMap((file) =>
                  file.name !== "diagnostics.json"
                    ? []
                    : [
                        <a
                          key={file.name}
                          className="bug-report-status"
                          href={bugReportFileUrl(reportId, file.name)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <FileJson aria-hidden="true" />
                          diagnostics.json
                        </a>,
                      ],
                )}
              </dd>
            </dl>
            {detail.data.files.flatMap((file) =>
              file.name !== "dictation.wav"
                ? []
                : [
                    // biome-ignore lint/a11y/useMediaCaption: a dictation has no captions; its transcript is in diagnostics.json.
                    <audio
                      key={file.name}
                      controls
                      preload="none"
                      src={bugReportFileUrl(reportId, file.name)}
                      aria-label="Dictation audio"
                    />,
                  ],
            )}
            <p className="bug-report-detail-message">
              {detail.data.report.message}
            </p>
            {detail.data.report.imageCount === 0 ? null : (
              <ul className="bug-report-detail-images" aria-label="Images">
                {detail.data.files.flatMap((image) =>
                  !image.contentType.startsWith("image/")
                    ? []
                    : [
                        <li key={image.name}>
                          <a
                            href={bugReportFileUrl(reportId, image.name)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <img
                              src={bugReportFileUrl(reportId, image.name)}
                              alt={image.name}
                            />
                          </a>
                        </li>,
                      ],
                )}
              </ul>
            )}
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

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
        <span className="bug-report-status" data-status={report.status}>
          {statusText(report)}
        </span>
      </Link>
    </li>
  );
}

/**
 * Your Reports: one row per bug report the person sent. A row opens its
 * report in a dialog, and `/bug-reports/<id>` (an issue's link) opens the
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
        <div className="empty-state bug-reports-empty">
          <strong>Your reports could not be loaded.</strong>
        </div>
      ) : reports.data.length === 0 ? (
        <div className="empty-state bug-reports-empty">
          <strong>No bug reports yet</strong>
          <span>Report Bug is in a Thread's More Actions menu.</span>
        </div>
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
