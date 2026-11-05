import type {
  BugReportData,
  BugReportDiagnosticKind,
  BugReportFile,
  BugReportId,
} from "@dx/api";
import { BugReportDataSchema } from "@dx/api";
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
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO bug_report
         (id, reporter_user_id, thread_id, message, image_count, diagnostics,
          created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      report.id,
      report.reporterUserId,
      report.threadId ?? null,
      report.message,
      report.imageCount,
      JSON.stringify(report.diagnostics),
      now.toISOString(),
    )
    .run();
};

/**
 * The reporter of a report another deployment forwarded: no person's ID, so
 * only report readers open it.
 */
export const intakeReporter = (sender: string) => `intake:${sender}`;

/**
 * Keeps a report another deployment forwarded, once: a retry of the same
 * sender's report returns the ID it was kept under, with `created` false.
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
  now = new Date(),
): Promise<{ readonly id: BugReportId; readonly created: boolean }> => {
  const inserted = await db
    .prepare(
      `INSERT INTO bug_report
         (id, reporter_user_id, thread_id, message, image_count, diagnostics,
          created_at, source_sender, source_origin, source_report_id,
          source_thread_id)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
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
  return { id: existing?.id ?? report.id, created: false };
};

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

/**
 * Whether this person is one of the deployment's report readers: a person
 * whose verified email `DX_BUG_REPORT_READERS` lists. Readers open every
 * report; everyone else opens only their own.
 */
export const isBugReportReader = async (
  db: D1Database,
  userId: string,
  readers: string | undefined,
) => {
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

/** Whether this person may open a report: its reporter, or a report reader. */
export const mayReadBugReport = async (
  db: D1Database,
  userId: string,
  reporterUserId: string,
  readers: string | undefined,
) =>
  userId === reporterUserId || (await isBugReportReader(db, userId, readers));

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
export const BUG_REPORT_FILE_NAME =
  /^(?:diagnostics\.json|dictation\.wav|image-[1-5]\.(?:png|jpg|gif|webp))$/;

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
