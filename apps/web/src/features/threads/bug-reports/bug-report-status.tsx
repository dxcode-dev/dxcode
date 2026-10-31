import type { BugReportData } from "@dx/api";
import { ExternalLink } from "lucide-react";
import { statusText } from "./bug-report-format.js";

export function ReportStatus({ report }: { readonly report: BugReportData }) {
  const text = statusText(report);
  return report.issue === undefined ? (
    <span className="bug-report-status" data-status={report.status}>
      {text}
    </span>
  ) : (
    <a
      className="bug-report-status"
      data-status={report.status}
      href={report.issue.url}
      target="_blank"
      rel="noreferrer"
    >
      {text}
      <ExternalLink aria-hidden="true" />
    </a>
  );
}
