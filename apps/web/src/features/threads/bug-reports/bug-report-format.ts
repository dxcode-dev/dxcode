import type { BugReportData } from "@dx/api";

export const firstLine = (message: string) =>
  message.split("\n").find((line) => line.trim() !== "") ?? message;

/** Where a report was sent from: a Thread, or Settings with no Thread. */
export const reportSource = (report: BugReportData) =>
  report.threadId === undefined ? "Settings" : "Thread";

/** The dx deployment that keeps every report sent from this app. */
export const reportDestination = () => window.location.host;
