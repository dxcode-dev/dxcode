import type {
  BugReportData,
  BugReportDiagnosticKind,
  BugReportFile,
  BugReportId,
} from "@dx/api";
import { BUG_REPORT_FILE_NAME, BugReportDataSchema } from "@dx/api";
import { Option, Schema } from "effect";

interface BugReportRow {
  readonly id: string;
  readonly reporter_user_id: string;
  readonly thread_id: string | null;
  readonly message: string;
  readonly image_count: number;
  readonly diagnostics: string;
  readonly created_at: string;
  readonly source_sender: string | null;
  readonly source_origin: string | null;
}

const COLUMNS = `id, reporter_user_id, thread_id, message, image_count,
                 diagnostics, created_at, source_sender, source_origin`;

const decode = Schema.decodeUnknownOption(BugReportDataSchema);

const reportData = (row: BugReportRow) =>
  decode({
    id: row.id,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    message: row.message,
    createdAt: row.created_at,
    imageCount: row.image_count,
    diagnostics: (() => {
      try {
        return JSON.parse(row.diagnostics) as unknown;
      } catch {
        return [];
      }
    })(),
    ...(row.source_sender === null
      ? {}
      : {
          source: {
            sender: row.source_sender,
            origin: row.source_origin ?? "",
          },
        }),
  });

/** A report and who sent it, as dx user ID. */
export interface KeptBugReport {
  readonly report: BugReportData;
  readonly reporterUserId: string;
}

const kept = (row: BugReportRow): ReadonlyArray<KeptBugReport> =>
  Option.toArray(
    Option.map(reportData(row), (report) => ({
      report,
      reporterUserId: row.reporter_user_id,
    })),
  );

export const newBugReportId = () =>
  `bug_${crypto.randomUUID().replaceAll("-", "")}` as BugReportId;

/**
 * The ID a person's report gets from the key their send carries, the same
 * on every retry of one send, so a retry finds the report it already kept.
 * The reporter is part of it: another person's key never names their report.
 */
export const bugReportIdFor = async (reporterUserId: string, key: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${reporterUserId}\n${key}`),
    ),
  );
  return `bug_${[...digest.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}` as BugReportId;
};

/**
 * At most `maximum` reports since `since`. Checked in the insert itself, so
 * concurrent sends cannot all pass a count taken before any of them is kept
 * (#2690).
 */
export interface ReportLimit {
  readonly since: Date;
  readonly maximum: number;
}

/**
 * Keeps a report once: `repeated` when its ID was kept already, `limited`
 * when the reporter has kept `limit.maximum` since `limit.since`.
 */
export const insertBugReport = async (
  db: D1Database,
  report: {
    readonly id: BugReportId;
    readonly reporterUserId: string;
    /** Absent for a report sent from Settings. */
    readonly threadId?: string;
    readonly message: string;
    readonly imageCount: number;
    readonly diagnostics: ReadonlyArray<BugReportDiagnosticKind>;
  },
  limit: ReportLimit,
  now = new Date(),
): Promise<"created" | "repeated" | "limited"> => {
  const inserted = await db
    .prepare(
      `INSERT INTO bug_report
         (id, reporter_user_id, thread_id, message, image_count, diagnostics,
          created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
        WHERE (SELECT COUNT(*) FROM bug_report
                WHERE reporter_user_id = ?2 AND created_at >= ?8) < ?9
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      report.id,
      report.reporterUserId,
      report.threadId ?? null,
      report.message,
      report.imageCount,
      JSON.stringify(report.diagnostics),
      now.toISOString(),
      limit.since.toISOString(),
      limit.maximum,
    )
    .run();
  if (inserted.meta.changes > 0) return "created";
  const existing = await db
    .prepare("SELECT 1 AS found FROM bug_report WHERE id = ?1")
    .bind(report.id)
    .first();
  return existing === null ? "limited" : "repeated";
};

/** Removes a report a send could not keep whole. */
export const deleteBugReport = async (db: D1Database, id: BugReportId) => {
  await db.prepare("DELETE FROM bug_report WHERE id = ?1").bind(id).run();
};

/**
 * The reporter of a report another deployment forwarded: no person's ID, so
 * only report readers open it.
 */
export const intakeReporter = (sender: string) => `intake:${sender}`;

/**
 * Keeps a report another deployment forwarded, once: a retry of the same
 * sender's report returns the ID it was kept under, with `created` false,
 * and a new one past `limit` is `limited`.
 */
export const insertReceivedBugReport = async (
  db: D1Database,
  report: {
    readonly id: BugReportId;
    readonly sender: string;
    readonly origin: string;
    readonly sourceReportId: string;
    readonly sourceThreadId?: string;
    readonly message: string;
    readonly imageCount: number;
    readonly diagnostics: ReadonlyArray<BugReportDiagnosticKind>;
  },
  limit: ReportLimit,
  now = new Date(),
): Promise<
  | { readonly id: BugReportId; readonly created: boolean }
  | { readonly limited: true }
> => {
  const inserted = await db
    .prepare(
      `INSERT INTO bug_report
         (id, reporter_user_id, thread_id, message, image_count, diagnostics,
          created_at, source_sender, source_origin, source_report_id,
          source_thread_id)
       SELECT ?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
        WHERE (SELECT COUNT(*) FROM bug_report
                WHERE source_sender = ?7 AND created_at >= ?11) < ?12
       ON CONFLICT (source_sender, source_report_id)
         WHERE source_sender IS NOT NULL DO NOTHING`,
    )
    .bind(
      report.id,
      intakeReporter(report.sender),
      report.message,
      report.imageCount,
      JSON.stringify(report.diagnostics),
      now.toISOString(),
      report.sender,
      report.origin,
      report.sourceReportId,
      report.sourceThreadId ?? null,
      limit.since.toISOString(),
      limit.maximum,
    )
    .run();
  if (inserted.meta.changes > 0) return { id: report.id, created: true };
  const existing = await db
    .prepare(
      `SELECT id FROM bug_report
        WHERE source_sender = ?1 AND source_report_id = ?2`,
    )
    .bind(report.sender, report.sourceReportId)
    .first<{ id: BugReportId }>();
  return existing === null
    ? { limited: true }
    : { id: existing.id, created: false };
};

/** How many reports this person sent since `since`. */
export const countReportedSince = async (
  db: D1Database,
  reporterUserId: string,
  since: Date,
) =>
  (
    await db
      .prepare(
        `SELECT COUNT(*) AS count FROM bug_report
          WHERE reporter_user_id = ?1 AND created_at >= ?2`,
      )
      .bind(reporterUserId, since.toISOString())
      .first<{ count: number }>()
  )?.count ?? 0;

/** How many reports this sender forwarded since `since`. */
export const countReceivedSince = async (
  db: D1Database,
  sender: string,
  since: Date,
) =>
  (
    await db
      .prepare(
        `SELECT COUNT(*) AS count FROM bug_report
          WHERE source_sender = ?1 AND created_at >= ?2`,
      )
      .bind(sender, since.toISOString())
      .first<{ count: number }>()
  )?.count ?? 0;

export const readBugReport = async (
  db: D1Database,
  id: BugReportId,
): Promise<KeptBugReport | undefined> => {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM bug_report WHERE id = ?1`)
    .bind(id)
    .first<BugReportRow>();
  return row === null ? undefined : kept(row)[0];
};

/** The bindings that name report readers. */
export type BugReportReaderBindings = {
  readonly DX_BUG_REPORT_READERS?: string | undefined;
  readonly DX_DEPLOYMENT_ADMIN_EMAILS?: string | undefined;
};

const emailList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== "");

/**
 * Whether this person is one of the deployment's report readers: a person
 * whose verified email `DX_BUG_REPORT_READERS` lists, or a deployment
 * administrator (`DX_DEPLOYMENT_ADMIN_EMAILS`), who triages reports in
 * Admin. Readers open every report; everyone else opens only their own.
 */
export const isBugReportReader = async (
  db: D1Database,
  userId: string,
  bindings: BugReportReaderBindings,
) => {
  const emails = [
    ...emailList(bindings.DX_BUG_REPORT_READERS),
    ...emailList(bindings.DX_DEPLOYMENT_ADMIN_EMAILS),
  ];
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

/** Whether this person may open a report: its reporter, or a report reader. */
export const mayReadBugReport = async (
  db: D1Database,
  userId: string,
  reporterUserId: string,
  bindings: BugReportReaderBindings,
) =>
  userId === reporterUserId || (await isBugReportReader(db, userId, bindings));

/**
 * Reports newest first: one reporter's, or with no reporter every report,
 * for report readers. `before` continues after the last report of a page.
 */
export const listBugReports = async (
  db: D1Database,
  options: {
    readonly reporterUserId?: string;
    readonly limit?: number;
    readonly before?: { readonly createdAt: string; readonly id: string };
  } = {},
): Promise<ReadonlyArray<KeptBugReport>> => {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (options.reporterUserId !== undefined) {
    values.push(options.reporterUserId);
    conditions.push(`reporter_user_id = ?${values.length}`);
  }
  if (options.before !== undefined) {
    values.push(options.before.createdAt, options.before.id);
    conditions.push(
      `(created_at < ?${values.length - 1} OR (created_at = ?${values.length - 1} AND id < ?${values.length}))`,
    );
  }
  values.push(options.limit ?? 50);
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS}
         FROM bug_report
        ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
        ORDER BY created_at DESC, id DESC
        LIMIT ?${values.length}`,
    )
    .bind(...values)
    .all<BugReportRow>();
  return rows.results.flatMap(kept);
};

/** The files a report may hold in `DX_STORAGE`, by name. */
export { BUG_REPORT_FILE_NAME };

export const bugReportFileKey = (id: BugReportId, name: string) =>
  `bug-reports/${id}/${name}`;

/** A report's images, `diagnostics.json`, and dictation audio. */
export const listBugReportFiles = async (
  bucket: R2Bucket | undefined,
  id: BugReportId,
): Promise<ReadonlyArray<BugReportFile>> => {
  const prefix = bugReportFileKey(id, "");
  const listed = await bucket?.list({ prefix, include: ["httpMetadata"] });
  return (listed?.objects ?? []).flatMap((object) => {
    const name = object.key.slice(prefix.length);
    return BUG_REPORT_FILE_NAME.test(name)
      ? [
          {
            name,
            size: object.size,
            contentType:
              object.httpMetadata?.contentType ?? "application/octet-stream",
          },
        ]
      : [];
  });
};
