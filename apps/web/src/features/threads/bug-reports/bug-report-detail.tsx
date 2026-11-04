import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileJson } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { firstLine, sentAt } from "./bug-report-format.js";
import { InvestigationFooter } from "./bug-report-investigation.js";
import {
  bugReportFileUrl,
  bugReportQueryOptions,
} from "./bug-report-queries.js";
import "./bug-reports.css";

const DIAGNOSTIC_LABELS = {
  "thread-and-app": "Thread and App Diagnostics",
  app: "App Diagnostics",
  changes: "Diff Diagnostics",
  dictation: "Dictation Diagnostics",
} as const;

/** One report, opened from its row: what was sent, and from where. */
export function BugReportDialog({
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
              <dt>Sent</dt>
              <dd>
                <time dateTime={detail.data.report.createdAt}>
                  {sentAt(detail.data.report.createdAt)}
                </time>
              </dd>
              <dt>From</dt>
              <dd>
                {detail.data.report.threadId === undefined ? (
                  "Settings"
                ) : (
                  <Link
                    to="/threads/$threadId"
                    params={{ threadId: detail.data.report.threadId }}
                  >
                    {detail.data.report.threadId}
                  </Link>
                )}
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
            <InvestigationFooter
              reportId={reportId}
              investigation={detail.data.investigation}
            />
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
