import type { BugReportId, BugReportIntakeRequest } from "@dx/api";
import type { Bindings } from "../http/types.js";
import { bugReportLogger } from "../logging.js";
import { redactBugReportText, redactBugReportValue } from "./redaction.js";
import { bugReportFileKey, listBugReportFiles } from "./repository.js";

/**
 * Forwarding: a deployment whose deploy names a central dx deployment
 * (`DX_BUG_REPORT_DESTINATION`) and gives it an intake key
 * (`DX_BUG_REPORT_DESTINATION_KEY`) sends each report it keeps there too.
 * The report is kept here first, and sending it never fails or delays the
 * person's report: one try runs right after, and the cron retries the rest
 * for 24 hours (`bug_report_forward`, migration 0145).
 */

/** The central deployment's intake, under its origin. */
export const BUG_REPORT_INTAKE_PATH = "/api/bug-reports/intake";

/** How long a report keeps trying to reach the central deployment. */
const FORWARD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Waits after each failed try: 1, 5, 15, 30 minutes, then hourly. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** A try holds its row this long, so another try cannot send it meanwhile. */
const CLAIM_MS = 2 * 60_000;
const SEND_TIMEOUT_MS = 30_000;
/**
 * Answers that refuse the report itself, which no retry changes. Any other
 * answer retries within the window: the edge's own errors for a central host
 * not deployed yet (a 409 on Cloudflare), an intake not turned on yet (404),
 * or a key the central deployment does not take until the operator redeploys
 * with the right one (401).
 */
const REFUSED_REPORT = new Set([400, 413]);
/** Reports one cron tick retries. */
const SWEEP_LIMIT = 10;

const isLocalHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

export interface ForwardingDestination {
  /** The central deployment's origin. */
  readonly origin: string;
  /** Its host, as Report Bug names it. */
  readonly host: string;
  readonly key: string;
}

/**
 * Where this deployment shares its reports, or nothing: both settings must
 * be set, and the destination must be another `https` origin (`http` only
 * on localhost, for local development).
 */
export const forwardingDestination = (
  bindings: Pick<
    Bindings,
    | "DX_BUG_REPORT_DESTINATION"
    | "DX_BUG_REPORT_DESTINATION_KEY"
    | "DX_AUTH_URL"
  >,
): ForwardingDestination | undefined => {
  const raw = bindings.DX_BUG_REPORT_DESTINATION?.trim();
  const key = bindings.DX_BUG_REPORT_DESTINATION_KEY?.trim();
  if (!raw || !key) return undefined;
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (
    url === undefined ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLocalHost(url.hostname))
    )
  )
    return undefined;
  const own =
    bindings.DX_AUTH_URL !== undefined && URL.canParse(bindings.DX_AUTH_URL)
      ? new URL(bindings.DX_AUTH_URL).origin
      : undefined;
  if (url.origin === own) return undefined;
  return { origin: url.origin, host: url.host, key };
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const USER_ID = /\busr_[A-Za-z0-9_-]{6,}/g;

/**
 * A string as it may leave this deployment: redacted again, with every
 * email address, dx user ID, and the reporter's own ID removed, so neither
 * the reporter nor anyone named in a shared Thread is identified there.
 */
const anonymous = (text: string, reporterUserId: string) =>
  redactBugReportText(
    (reporterUserId.length >= 4
      ? text.split(reporterUserId).join("[user]")
      : text
    )
      .replace(EMAIL, "[email]")
      .replace(USER_ID, "[user]"),
  );

const anonymousValue = (value: unknown, reporterUserId: string): unknown => {
  if (typeof value === "string") return anonymous(value, reporterUserId);
  if (Array.isArray(value))
    return value.map((item) => anonymousValue(item, reporterUserId));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        anonymous(key, reporterUserId),
        anonymousValue(item, reporterUserId),
      ]),
    );
  return value;
};

/**
 * `diagnostics.json` as it may leave: without the reporter's user ID in its
 * header, and anonymous throughout.
 */
const forwardedDiagnostics = (bytes: ArrayBuffer, reporterUserId: string) => {
  const parsed = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { report, ...rest } = parsed as { report?: unknown };
  const header =
    report !== null && typeof report === "object"
      ? Object.fromEntries(
          Object.entries(report).filter(([key]) => key !== "reporterUserId"),
        )
      : undefined;
  return new TextEncoder().encode(
    `${JSON.stringify(
      redactBugReportValue(
        anonymousValue(
          { ...(header === undefined ? {} : { report: header }), ...rest },
          reporterUserId,
        ),
      ),
      null,
      2,
    )}\n`,
  );
};

interface StoredReport {
  readonly id: BugReportId;
  readonly reporter_user_id: string;
  readonly thread_id: string | null;
  readonly message: string;
  readonly diagnostics: string;
  readonly created_at: string;
}

/**
 * The form the central deployment's intake takes: the report's `report`
 * JSON and its kept files, anonymous, under the names they are kept by.
 */
const forwardForm = async (
  bindings: Bindings,
  report: StoredReport,
  ownOrigin: string,
) => {
  const intake: BugReportIntakeRequest = {
    message: anonymous(report.message, report.reporter_user_id),
    diagnostics: (() => {
      try {
        return JSON.parse(report.diagnostics) as never;
      } catch {
        return [];
      }
    })(),
    source: {
      origin: ownOrigin,
      reportId: report.id,
      ...(report.thread_id === null
        ? {}
        : { threadId: report.thread_id as never }),
      createdAt: report.created_at,
    },
  };
  const form = new FormData();
  form.set("report", JSON.stringify(intake));
  const bucket = bindings.DX_STORAGE;
  for (const file of await listBugReportFiles(bucket, report.id)) {
    const object = await bucket?.get(bugReportFileKey(report.id, file.name));
    if (object === null || object === undefined) continue;
    const bytes = await object.arrayBuffer();
    const body =
      file.name === "diagnostics.json"
        ? forwardedDiagnostics(bytes, report.reporter_user_id)
        : new Uint8Array(bytes);
    if (body === undefined) continue;
    form.append(
      "file",
      new File([body], file.name, { type: file.contentType }),
      file.name,
    );
  }
  return form;
};

/**
 * Records that a report kept here goes to the central deployment, due now.
 * Nothing when this deployment shares no reports.
 */
export const queueBugReportForward = async (
  bindings: Bindings,
  db: D1Database,
  reportId: BugReportId,
  now = new Date(),
) => {
  const destination = forwardingDestination(bindings);
  if (destination === undefined) return false;
  await db
    .prepare(
      `INSERT INTO bug_report_forward
         (report_id, destination, attempts, next_attempt_at, created_at)
       VALUES (?1, ?2, 0, ?3, ?3)
       ON CONFLICT (report_id) DO NOTHING`,
    )
    .bind(reportId, destination.origin, now.toISOString())
    .run();
  return true;
};

type Outcome = "forwarded" | "retry" | "failed" | "skipped";

/**
 * One try at sending a queued report. It claims the row first, so the try
 * right after a report and a cron retry never send at once (the intake
 * would keep one copy anyway). A 2xx forwards it; a 400 or 413 stops it;
 * anything else, or no answer, retries later until 24 hours have passed.
 */
export const deliverBugReportForward = async (
  bindings: Bindings,
  reportId: BugReportId,
  now = new Date(),
): Promise<Outcome> => {
  const db = bindings.DB;
  const destination = forwardingDestination(bindings);
  if (db === undefined || destination === undefined) return "skipped";
  const claimed = await db
    .prepare(
      `UPDATE bug_report_forward
          SET next_attempt_at = ?2, attempts = attempts + 1
        WHERE report_id = ?1 AND forwarded_at IS NULL AND failed_at IS NULL
          AND next_attempt_at <= ?3
        RETURNING attempts, created_at`,
    )
    .bind(
      reportId,
      new Date(now.getTime() + CLAIM_MS).toISOString(),
      now.toISOString(),
    )
    .first<{ attempts: number; created_at: string }>();
  if (claimed === null) return "skipped";
  const report = await db
    .prepare(
      `SELECT id, reporter_user_id, thread_id, message, diagnostics, created_at
         FROM bug_report WHERE id = ?1`,
    )
    .bind(reportId)
    .first<StoredReport>();
  if (report === null) return "skipped";
  const ownOrigin =
    bindings.DX_AUTH_URL !== undefined && URL.canParse(bindings.DX_AUTH_URL)
      ? new URL(bindings.DX_AUTH_URL).origin
      : "http://localhost";
  const status = await (async () => {
    try {
      const response = await fetch(
        `${destination.origin}${BUG_REPORT_INTAKE_PATH}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${destination.key}` },
          body: await forwardForm(bindings, report, ownOrigin),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          redirect: "manual",
        },
      );
      await response.body?.cancel();
      return response.status;
    } catch {
      return undefined;
    }
  })();
  const outcome: Outcome =
    status !== undefined && status >= 200 && status < 300
      ? "forwarded"
      : (status !== undefined && REFUSED_REPORT.has(status)) ||
          now.getTime() - Date.parse(claimed.created_at) >= FORWARD_WINDOW_MS
        ? "failed"
        : "retry";
  const wait =
    BACKOFF_MS[Math.min(claimed.attempts - 1, BACKOFF_MS.length - 1)] ??
    60 * 60_000;
  await db
    .prepare(
      `UPDATE bug_report_forward
          SET last_status = ?2,
              forwarded_at = ?3,
              failed_at = ?4,
              next_attempt_at = ?5
        WHERE report_id = ?1`,
    )
    .bind(
      reportId,
      status ?? null,
      outcome === "forwarded" ? now.toISOString() : null,
      outcome === "failed" ? now.toISOString() : null,
      new Date(now.getTime() + wait).toISOString(),
    )
    .run();
  const fields = {
    reportId,
    destination: destination.host,
    attempt: claimed.attempts,
    ...(status === undefined ? {} : { status }),
  };
  if (outcome === "forwarded")
    bugReportLogger.info("Bug report forwarded.", {
      event: "bug_report_forwarded",
      ...fields,
    });
  else if (outcome === "failed")
    bugReportLogger.error("Bug report could not be forwarded.", {
      event: "bug_report_forward_failed",
      ...fields,
    });
  else
    bugReportLogger.warn("Bug report forward will be retried.", {
      event: "bug_report_forward_retry",
      ...fields,
    });
  return outcome;
};

/** The cron's pass: retries reports whose next try is due. */
export const sweepBugReportForwards = async (
  bindings: Bindings,
  now = new Date(),
) => {
  const db = bindings.DB;
  if (db === undefined || forwardingDestination(bindings) === undefined)
    return [];
  const due = await db
    .prepare(
      `SELECT report_id FROM bug_report_forward
        WHERE forwarded_at IS NULL AND failed_at IS NULL
          AND next_attempt_at <= ?1
        ORDER BY next_attempt_at
        LIMIT ?2`,
    )
    .bind(now.toISOString(), SWEEP_LIMIT)
    .all<{ report_id: BugReportId }>();
  const outcomes: Array<Outcome> = [];
  for (const { report_id } of due.results)
    outcomes.push(await deliverBugReportForward(bindings, report_id, now));
  return outcomes;
};
