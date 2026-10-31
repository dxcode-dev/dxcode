import type {
  BugReportData,
  BugReportDiagnosticKind,
  BugReportId,
  BugReportStatus,
} from "@dx/api";
import { BugReportDataSchema } from "@dx/api";
import { Option, Schema } from "effect";

interface BugReportRow {
  readonly id: string;
  readonly reporter_user_id: string;
  readonly thread_id: string;
  readonly message: string;
  readonly status: string;
  readonly issue_number: number | null;
  readonly issue_url: string | null;
  readonly image_count: number;
  readonly diagnostics: string;
  readonly created_at: string;
}

const decode = Schema.decodeUnknownOption(BugReportDataSchema);

/** Filing that has not settled by now stopped with its Worker. */
const FILING_STALE_MS = 10 * 60 * 1_000;

const reportData = (row: BugReportRow, now = Date.now()) =>
  decode({
    id: row.id,
    threadId: row.thread_id,
    message: row.message,
    createdAt: row.created_at,
    status:
      row.status === "filing" &&
      now - Date.parse(row.created_at) > FILING_STALE_MS
        ? "failed"
        : row.status,
    ...(row.issue_number === null || row.issue_url === null
      ? {}
      : { issue: { number: row.issue_number, url: row.issue_url } }),
    imageCount: row.image_count,
    diagnostics: (() => {
      try {
        return JSON.parse(row.diagnostics) as unknown;
      } catch {
        return [];
      }
    })(),
  });

export const newBugReportId = () =>
  `bug_${crypto.randomUUID().replaceAll("-", "")}` as BugReportId;

export const insertBugReport = async (
  db: D1Database,
  report: {
    readonly id: BugReportId;
    readonly reporterUserId: string;
    readonly threadId: string;
    readonly message: string;
    readonly imageCount: number;
    readonly diagnostics: ReadonlyArray<BugReportDiagnosticKind>;
    readonly status: BugReportStatus;
  },
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO bug_report
         (id, reporter_user_id, thread_id, message, status, image_count,
          diagnostics, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
    .bind(
      report.id,
      report.reporterUserId,
      report.threadId,
      report.message,
      report.status,
      report.imageCount,
      JSON.stringify(report.diagnostics),
      now.toISOString(),
    )
    .run();
};

export const settleBugReport = async (
  db: D1Database,
  id: BugReportId,
  outcome:
    | {
        readonly status: "filed" | "commented";
        readonly issue: { readonly number: number; readonly url: string };
      }
    | { readonly status: "failed" | "saved" },
  now = new Date(),
) => {
  await db
    .prepare(
      `UPDATE bug_report
          SET status = ?2, issue_number = ?3, issue_url = ?4, updated_at = ?5
        WHERE id = ?1`,
    )
    .bind(
      id,
      outcome.status,
      "issue" in outcome ? outcome.issue.number : null,
      "issue" in outcome ? outcome.issue.url : null,
      now.toISOString(),
    )
    .run();
};

export const readBugReport = async (db: D1Database, id: BugReportId) => {
  const row = await db
    .prepare(
      `SELECT id, reporter_user_id, thread_id, message, status, issue_number,
              issue_url, image_count, diagnostics, created_at
         FROM bug_report WHERE id = ?1`,
    )
    .bind(id)
    .first<BugReportRow>();
  if (row === null) return undefined;
  const report = Option.getOrUndefined(reportData(row));
  return report === undefined
    ? undefined
    : { report, reporterUserId: row.reporter_user_id };
};

/**
 * Whether this person may open a report's files: its reporter, or a person
 * whose verified email the deployment lists in `DX_BUG_REPORT_READERS`.
 */
export const mayReadBugReport = async (
  db: D1Database,
  userId: string,
  reporterUserId: string,
  readers: string | undefined,
) => {
  if (userId === reporterUserId) return true;
  const emails = (readers ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== "");
  if (emails.length === 0) return false;
  const user = await db
    .prepare(`SELECT email, emailVerified FROM "user" WHERE id = ?1`)
    .bind(userId)
    .first<{ email: string; emailVerified: number }>();
  return (
    user !== null &&
    user.emailVerified === 1 &&
    emails.includes(user.email.toLowerCase())
  );
};

/** The person's newest reports, for Your Reports. */
export const listBugReports = async (
  db: D1Database,
  reporterUserId: string,
  limit = 50,
): Promise<ReadonlyArray<BugReportData>> => {
  const rows = await db
    .prepare(
      `SELECT id, reporter_user_id, thread_id, message, status, issue_number,
              issue_url, image_count, diagnostics, created_at
         FROM bug_report
        WHERE reporter_user_id = ?1
        ORDER BY created_at DESC
        LIMIT ?2`,
    )
    .bind(reporterUserId, limit)
    .all<BugReportRow>();
  return rows.results.flatMap((row) => Option.toArray(reportData(row)));
};
