import {
  BUG_REPORT_AUDIO_MAX_BYTES,
  BUG_REPORT_IMAGE_MAX_BYTES,
  BUG_REPORT_JSON_MAX_BYTES,
  BUG_REPORT_MAX_IMAGES,
  BugReportAccessResponseSchema,
  BugReportDetailResponseSchema,
  type BugReportDiagnosticKind,
  BugReportErrorResponseSchema,
  type BugReportId,
  BugReportIdSchema,
  BugReportInvestigationFailedResponseSchema,
  BugReportInvestigationResponseSchema,
  CreateAppBugReportRequestSchema,
  CreateBugReportRequestSchema,
  CreateBugReportResponseSchema,
  ListAllBugReportsResponseSchema,
  ListBugReportsResponseSchema,
  StartBugReportInvestigationRequestSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  MAX_JSON_REQUEST_BYTES,
  RequestBodyTooLarge,
  readBoundedFormData,
  readBoundedText,
} from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { bugReportLogger } from "../logging.js";
import { mayReadOrbContents } from "../thread-sharing/access.js";
import {
  deliverBugReportForward,
  forwardingDestination,
  queueBugReportForward,
} from "./forwarding.js";
import {
  investigateBugReport,
  mayOpenThread,
  readInvestigation,
} from "./investigation.js";
import { redactBugReportText, redactBugReportValue } from "./redaction.js";
import {
  BUG_REPORT_FILE_NAME,
  bugReportFileKey,
  insertBugReport,
  isBugReportReader,
  listBugReportFiles,
  listBugReports,
  mayReadBugReport,
  newBugReportId,
  readBugReport,
} from "./repository.js";
import {
  collectThreadServerDiagnostics,
  threadSecretValues,
} from "./thread-diagnostics.js";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

type ErrorCode = (typeof BugReportErrorResponseSchema.Type)["data"]["code"];
const MESSAGES = {
  INVALID_REQUEST: "The bug report is invalid.",
  TOO_LARGE: "The bug report is too large.",
  NOT_FOUND: "Bug report not found.",
  PERSISTENCE_UNAVAILABLE: "Persistence is temporarily unavailable.",
} as const satisfies Record<ErrorCode, string>;

const failure = (
  context: Context<AppEnv>,
  code: ErrorCode,
  status: 400 | 404 | 413 | 503,
) =>
  context.json(
    Schema.encodeUnknownSync(BugReportErrorResponseSchema)({
      status: "error",
      data: {
        code,
        message: MESSAGES[code],
        requestId: context.get("requestId"),
      },
    }),
    status,
  );

interface FormFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly type: string;
}

const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);

/**
 * The parts of a report form, or why they are refused: the `report` JSON
 * decoded with `schema`, naming no diagnostics but `kinds`; its images; and
 * the `audio` part, which only a report that `wantsAudio` may carry, and
 * must.
 */
const readForm = async <R extends { readonly message: string }>(
  context: Context<AppEnv>,
  schema: Schema.Codec<R, unknown>,
  kinds: ReadonlyArray<string>,
  wantsAudio: (report: R) => boolean,
) => {
  const form = await readBoundedFormData(
    context.req.raw,
    BUG_REPORT_JSON_MAX_BYTES +
      BUG_REPORT_MAX_IMAGES * BUG_REPORT_IMAGE_MAX_BYTES +
      BUG_REPORT_AUDIO_MAX_BYTES +
      64 * 1024,
  ).catch((error: unknown) =>
    error instanceof RequestBodyTooLarge ? ("TOO_LARGE" as const) : undefined,
  );
  if (form === "TOO_LARGE") return form;
  if (form === undefined) return "INVALID_REQUEST" as const;
  const raw = form.get("report");
  if (typeof raw !== "string") return "INVALID_REQUEST" as const;
  if (new TextEncoder().encode(raw).length > BUG_REPORT_JSON_MAX_BYTES)
    return "TOO_LARGE" as const;
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  })();
  // A Settings report must not carry a Thread's diagnostics unnoticed.
  const named = (parsed as { diagnostics?: unknown } | undefined)?.diagnostics;
  if (
    named !== null &&
    typeof named === "object" &&
    Object.keys(named).some((kind) => !kinds.includes(kind))
  )
    return "INVALID_REQUEST" as const;
  const report = Option.getOrUndefined(
    Schema.decodeUnknownOption(schema)(parsed),
  );
  if (report === undefined || report.message.trim() === "")
    return "INVALID_REQUEST" as const;
  const images = form.getAll("image");
  if (images.length > BUG_REPORT_MAX_IMAGES) return "TOO_LARGE" as const;
  const files: Array<FormFile> = [];
  for (const [index, image] of images.entries()) {
    if (typeof image === "string") return "INVALID_REQUEST" as const;
    const extension = IMAGE_EXTENSIONS[image.type];
    if (extension === undefined) return "INVALID_REQUEST" as const;
    if (image.size > BUG_REPORT_IMAGE_MAX_BYTES) return "TOO_LARGE" as const;
    files.push({
      name: `image-${index + 1}.${extension}`,
      bytes: new Uint8Array(await image.arrayBuffer()),
      type: image.type,
    });
  }
  // Dictation Diagnostics carry their audio; nothing else may.
  const audio = form.get("audio");
  if ((audio !== null) !== wantsAudio(report))
    return "INVALID_REQUEST" as const;
  if (audio === null) return { report, images: files, audio: [] };
  if (typeof audio === "string" || !AUDIO_TYPES.has(audio.type))
    return "INVALID_REQUEST" as const;
  if (audio.size > BUG_REPORT_AUDIO_MAX_BYTES) return "TOO_LARGE" as const;
  return {
    report,
    images: files,
    audio: [
      {
        name: "dictation.wav",
        bytes: new Uint8Array(await audio.arrayBuffer()),
        type: "audio/wav",
      },
    ],
  };
};

/**
 * Keeps one redacted report: its row in `bug_report` and its files in
 * `DX_STORAGE` under `bug-reports/<id>/`. A deployment that names a central
 * one also forwards it there (`forwarding.ts`).
 */
const keepReport = async (
  context: Context<AppEnv>,
  db: D1Database,
  input: {
    readonly threadId?: string;
    readonly message: string;
    readonly diagnostics: ReadonlyArray<BugReportDiagnosticKind>;
    readonly bundle: Record<string, unknown>;
    readonly images: ReadonlyArray<FormFile>;
    readonly audio: ReadonlyArray<FormFile>;
  },
) => {
  const reporter = context.get("actor") ?? context.get("principal");
  const files = [
    ...(input.diagnostics.length === 0
      ? []
      : [
          {
            name: "diagnostics.json",
            bytes: new TextEncoder().encode(
              `${JSON.stringify(
                {
                  report: {
                    ...(input.threadId === undefined
                      ? { source: "settings" }
                      : { threadId: input.threadId }),
                    reporterUserId: reporter.userId,
                    deployment: context.env.DX_AUTH_URL,
                    revision: context.env.DX_DEPLOYMENT_REVISION,
                  },
                  ...input.bundle,
                },
                null,
                2,
              )}\n`,
            ),
            type: "application/json",
          },
        ]),
    ...input.images,
    ...input.audio,
  ];
  const id = newBugReportId();
  try {
    await insertBugReport(db, {
      id,
      reporterUserId: reporter.userId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      message: input.message,
      imageCount: input.images.length,
      diagnostics: input.diagnostics,
    });
    const bucket = context.env.DX_STORAGE;
    if (bucket !== undefined)
      await Promise.all(
        files.map((file) =>
          bucket.put(bugReportFileKey(id, file.name), file.bytes, {
            httpMetadata: { contentType: file.type },
          }),
        ),
      );
  } catch (cause) {
    bugReportLogger.error("Bug report could not be kept.", {
      event: "bug_report_persistence_failed",
      requestId: context.get("requestId"),
      errorName: cause instanceof Error ? cause.name : "UnknownError",
    });
    return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
  }
  // Shared with the central deployment after it is kept here; the person's
  // report never waits for it or fails because of it.
  const forwarding = await queueBugReportForward(context.env, db, id).catch(
    () => false,
  );
  if (forwarding) {
    const sending = deliverBugReportForward(context.env, id).catch(() => {});
    try {
      context.executionCtx.waitUntil(sending);
    } catch {
      // No execution context outside a Worker request; the cron retries.
    }
  }
  bugReportLogger.info("Bug report received.", {
    event: "bug_report_received",
    reportId: id,
    ...(input.threadId === undefined
      ? { source: "settings" }
      : { threadId: input.threadId }),
    imageCount: input.images.length,
    diagnostics: input.diagnostics,
  });
  const report = await readBugReport(db, id);
  if (report === undefined)
    return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
  return context.json(
    Schema.encodeUnknownSync(CreateBugReportResponseSchema)({
      status: "success",
      data: report.report,
    }),
    201,
  );
};

/**
 * `POST /v1/threads/:threadId/bug-reports`, mounted after Thread
 * authorization: a bug report about this Thread. Every chosen diagnostic is
 * redacted before Core keeps it.
 */
export const threadBugReportRoutes = new Hono<AppEnv>().post(
  "/:threadId/bug-reports",
  async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const form = await readForm(
      context,
      CreateBugReportRequestSchema,
      ["threadAndApp", "changes", "dictation"],
      (report) => report.diagnostics.dictation !== undefined,
    );
    if (form === "INVALID_REQUEST") return failure(context, form, 400);
    if (form === "TOO_LARGE") return failure(context, form, 413);
    const threadId = context.req.param("threadId");
    const diagnostics: Array<BugReportDiagnosticKind> = [];
    const bundle: Record<string, unknown> = {};
    const { threadAndApp, changes, dictation } = form.report.diagnostics;
    if (threadAndApp !== undefined) {
      diagnostics.push("thread-and-app");
      const server = await collectThreadServerDiagnostics(
        context.env,
        context.get("principal").userId,
        threadId as ThreadId,
        // The reporter reads the report back: a View-only member's report
        // never reads the Orb.
        mayReadOrbContents(context.get("threadAccess")),
      );
      bundle.threadAndApp = redactBugReportValue(threadAndApp, server.secrets);
      bundle.thread = redactBugReportValue(server.value, server.secrets);
    }
    const secrets =
      changes === undefined && dictation === undefined
        ? []
        : await threadSecretValues(context.env, threadId as ThreadId).catch(
            () => [],
          );
    if (changes !== undefined) {
      diagnostics.push("changes");
      bundle.changes = redactBugReportValue(changes, secrets);
    }
    if (dictation !== undefined) {
      diagnostics.push("dictation");
      bundle.dictation = redactBugReportValue(dictation, secrets);
    }
    return keepReport(context, db, {
      threadId,
      message: redactBugReportText(form.report.message.trim()),
      diagnostics,
      bundle,
      images: form.images,
      audio: form.audio,
    });
  },
);

/** The host a forwarded report's sender stated, as its row shows it. */
const sourceHost = (origin: string) =>
  URL.canParse(origin) ? new URL(origin).host : origin;

/** Reports per page of All Bug Reports. */
const ALL_REPORTS_PAGE = 50;

/** Each reporter's display name and username, by dx user ID. */
const reporterNames = async (
  db: D1Database,
  userIds: ReadonlyArray<string>,
) => {
  if (userIds.length === 0)
    return new Map<string, { name: string; username?: string }>();
  const rows = await db
    .prepare(
      `SELECT u.id, u.name, account.display_name, account.username
         FROM "user" AS u
         LEFT JOIN personal_account AS account ON account.user_id = u.id
        WHERE u.id IN (${userIds.map((_, index) => `?${index + 1}`).join(", ")})`,
    )
    .bind(...userIds)
    .all<{
      id: string;
      name: string | null;
      display_name: string | null;
      username: string | null;
    }>();
  return new Map(
    rows.results.map((row) => [
      row.id,
      {
        name: row.display_name ?? row.name ?? row.username ?? "Unknown",
        ...(row.username === null ? {} : { username: row.username }),
      },
    ]),
  );
};

/** The report, when this person may open it. */
const readableReport = async (context: Context<AppEnv>, db: D1Database) => {
  const id = Option.getOrUndefined(
    Schema.decodeUnknownOption(BugReportIdSchema)(context.req.param("id")),
  );
  if (id === undefined) return undefined;
  const kept = await readBugReport(db, id as BugReportId);
  if (
    kept === undefined ||
    !(await mayReadBugReport(
      db,
      context.get("principal").userId,
      kept.reporterUserId,
      context.env.DX_BUG_REPORT_READERS,
    ))
  )
    return undefined;
  return kept.report;
};

/**
 * Mounted at `/v1/bug-reports`: a report sent from Settings, about no
 * Thread; Your Reports, the signed-in person's own; one report with its
 * images and diagnostics for its reporter and the deployment's report
 * readers; and the one Thread that investigates it, which only a person
 * who clicks Investigate starts.
 */
export const bugReportRoutes = new Hono<AppEnv>()
  .post("/", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const form = await readForm(
      context,
      CreateAppBugReportRequestSchema,
      ["app"],
      () => false,
    );
    if (form === "INVALID_REQUEST") return failure(context, form, 400);
    if (form === "TOO_LARGE") return failure(context, form, 413);
    const { app } = form.report.diagnostics;
    return keepReport(context, db, {
      message: redactBugReportText(form.report.message.trim()),
      diagnostics: app === undefined ? [] : ["app"],
      bundle: app === undefined ? {} : { app: redactBugReportValue(app, []) },
      images: form.images,
      audio: [],
    });
  })
  .get("/", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const items = await listBugReports(db, {
      reporterUserId: context.get("principal").userId,
    });
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(ListBugReportsResponseSchema)({
        status: "success",
        data: { items: items.map(({ report }) => report) },
      }),
      200,
    );
  })
  .get("/access", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const reader = await isBugReportReader(
      db,
      context.get("principal").userId,
      context.env.DX_BUG_REPORT_READERS,
    );
    const destination = forwardingDestination(context.env);
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(BugReportAccessResponseSchema)({
        status: "success",
        data: {
          reader,
          ...(destination === undefined
            ? {}
            : { sharedWith: destination.host }),
        },
      }),
      200,
    );
  })
  .get("/all", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const userId = context.get("principal").userId;
    // Everyone else is told there is nothing here.
    if (
      !(await isBugReportReader(db, userId, context.env.DX_BUG_REPORT_READERS))
    )
      return failure(context, "NOT_FOUND", 404);
    const beforeId = context.req.query("before");
    const before =
      beforeId === undefined
        ? undefined
        : Option.getOrUndefined(
            Schema.decodeUnknownOption(BugReportIdSchema)(beforeId),
          );
    if (beforeId !== undefined && before === undefined)
      return failure(context, "INVALID_REQUEST", 400);
    const after =
      before === undefined
        ? undefined
        : await readBugReport(db, before as BugReportId);
    if (before !== undefined && after === undefined)
      return failure(context, "INVALID_REQUEST", 400);
    const page = await listBugReports(db, {
      limit: ALL_REPORTS_PAGE + 1,
      ...(after === undefined
        ? {}
        : {
            before: {
              createdAt: after.report.createdAt,
              id: after.report.id,
            },
          }),
    });
    const items = page.slice(0, ALL_REPORTS_PAGE);
    const reporters = await reporterNames(db, [
      ...new Set(items.map(({ reporterUserId }) => reporterUserId)),
    ]);
    const last = items.at(-1);
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(ListAllBugReportsResponseSchema)({
        status: "success",
        data: {
          items: items.map(({ report, reporterUserId }) => ({
            ...report,
            reporter:
              report.source === undefined
                ? {
                    ...(reporters.get(reporterUserId) ?? { name: "Unknown" }),
                    you: reporterUserId === userId,
                  }
                : // Forwarded: its sender's deployment, never a person.
                  { name: sourceHost(report.source.origin), you: false },
          })),
          ...(page.length > ALL_REPORTS_PAGE && last !== undefined
            ? { nextCursor: last.report.id }
            : {}),
        },
      }),
      200,
    );
  })
  .get("/:id", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const report = await readableReport(context, db);
    if (report === undefined) return failure(context, "NOT_FOUND", 404);
    const [files, investigation] = await Promise.all([
      listBugReportFiles(context.env.DX_STORAGE, report.id),
      readInvestigation(db, report.id),
    ]);
    const principal = context.get("principal");
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(BugReportDetailResponseSchema)({
        status: "success",
        data: {
          report,
          files,
          ...(investigation === undefined
            ? {}
            : {
                investigation: (await mayOpenThread(
                  db,
                  principal,
                  investigation.threadId,
                ))
                  ? { threadId: investigation.threadId }
                  : {},
              }),
        },
      }),
      200,
    );
  })
  .post("/:id/investigation", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const id = Option.getOrUndefined(
      Schema.decodeUnknownOption(BugReportIdSchema)(context.req.param("id")),
    );
    if (id === undefined) return failure(context, "NOT_FOUND", 404);
    const text = await readBoundedText(
      context.req.raw,
      MAX_JSON_REQUEST_BYTES,
    ).catch(() => undefined);
    // An empty body asks for the defaults; one over the cap is refused.
    if (text === undefined) return failure(context, "INVALID_REQUEST", 400);
    const input = Option.getOrUndefined(
      Schema.decodeUnknownOption(StartBugReportInvestigationRequestSchema)(
        (() => {
          try {
            return text === undefined || text.trim() === ""
              ? {}
              : (JSON.parse(text) as unknown);
          } catch {
            return undefined;
          }
        })(),
      ),
    );
    if (input === undefined) return failure(context, "INVALID_REQUEST", 400);
    const execution = (() => {
      try {
        return context.executionCtx;
      } catch {
        return undefined;
      }
    })();
    const outcome = await investigateBugReport({
      bindings: context.env,
      principal: context.get("principal"),
      reportId: id as BugReportId,
      ...(input.selection === undefined ? {} : { selection: input.selection }),
      ...(input.claudeConnectionId === undefined
        ? {}
        : { claudeConnectionId: input.claudeConnectionId }),
      ...(execution === undefined
        ? {}
        : { waitUntil: (promise) => execution.waitUntil(promise) }),
    });
    if (outcome.kind === "not-found") return failure(context, "NOT_FOUND", 404);
    if (outcome.kind === "failed")
      return context.json(
        Schema.encodeUnknownSync(BugReportInvestigationFailedResponseSchema)({
          status: "error",
          data: {
            code: "INVESTIGATION_NOT_STARTED",
            message: outcome.message,
            requestId: context.get("requestId"),
          },
        }),
        outcome.status >= 400 && outcome.status < 600
          ? (outcome.status as 400)
          : 503,
      );
    return context.json(
      Schema.encodeUnknownSync(BugReportInvestigationResponseSchema)({
        status: "success",
        data: {
          ...(outcome.threadId === undefined
            ? {}
            : { threadId: outcome.threadId }),
          started: outcome.kind === "started",
        },
      }),
      outcome.kind === "started" ? 201 : 200,
    );
  })
  .get("/:id/files/:name", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const name = context.req.param("name");
    const report = BUG_REPORT_FILE_NAME.test(name)
      ? await readableReport(context, db)
      : undefined;
    const object =
      report === undefined
        ? null
        : await context.env.DX_STORAGE?.get(bugReportFileKey(report.id, name));
    if (object === null || object === undefined)
      return failure(context, "NOT_FOUND", 404);
    return new Response(object.body, {
      headers: {
        "content-type":
          object.httpMetadata?.contentType ?? "application/octet-stream",
        "content-length": String(object.size),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });
