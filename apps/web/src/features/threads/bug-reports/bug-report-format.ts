import type { BugReportData } from "@dx/api";

export const firstLine = (message: string) =>
  message.split("\n").find((line) => line.trim() !== "") ?? message;

/** Where a report was sent from: a Thread, or Settings with no Thread. */
export const reportSource = (report: BugReportData) =>
  report.threadId === undefined ? "Settings" : "Thread";

/** The dx deployment that keeps every report sent from this app. */
export const reportDestination = () => window.location.host;

/** When a report was sent, as its row and dialog show it. */
export const sentAt = (createdAt: string) =>
  new Date(createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
