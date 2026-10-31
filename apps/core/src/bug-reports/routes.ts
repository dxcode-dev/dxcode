import {
  BUG_REPORT_AUDIO_MAX_BYTES,
  BUG_REPORT_IMAGE_MAX_BYTES,
  BUG_REPORT_JSON_MAX_BYTES,
  BUG_REPORT_MAX_IMAGES,
  BugReportDetailResponseSchema,
  type BugReportDiagnosticKind,
  BugReportErrorResponseSchema,
  type BugReportId,
  BugReportIdSchema,
  type BugReportThreadAndAppDiagnostics,
  CreateBugReportRequestSchema,
  CreateBugReportResponseSchema,
  ListBugReportsResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { bugReportLogger } from "../logging.js";
import { type FiledReport, fileBugReport } from "./filing.js";
import { bugReportFiling } from "./github.js";
import { redactBugReportText, redactBugReportValue } from "./redaction.js";
import {
  insertBugReport,
  listBugReports,
  mayReadBugReport,
  newBugReportId,
  readBugReport,
  settleBugReport,
} from "./repository.js";
import {
  collectThreadServerDiagnostics,
  type ThreadServerDiagnostics,
  threadSecretValues,
} from "./thread-diagnostics.js";

/** How long a send waits for filing before answering `filing`. */
const FILING_WAIT_MS = 25_000;

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

const keepRunning = (context: Context<AppEnv>, work: Promise<unknown>) => {
  try {
    context.executionCtx.waitUntil(work.catch(() => undefined));
  } catch {
    // No execution context (tests): the work still runs.
  }
};

const count = (value: number, one: string, many = `${one}s`) =>
  `${value} ${value === 1 ? one : many}`;

/** Thread and App Diagnostics in counts, for the issue body. */
const threadAndAppSummary = (diagnostics: BugReportThreadAndAppDiagnostics) => {
  const turns = (diagnostics.transcript as { turns?: unknown } | undefined)
    ?.turns;
  const errors = diagnostics.logs.filter(({ level }) => level === "error");
  return [
    Array.isArray(turns)
      ? `Transcript: ${count(turns.length, "turn")}`
      : undefined,
    `App log: ${count(errors.length, "error")}, ${count(diagnostics.logs.length - errors.length, "warning")}`,
    `Failed requests: ${diagnostics.failedRequests.length}`,
    `Connection events: ${diagnostics.connection.length}`,
  ].filter((line) => line !== undefined);
};

/** What Core read about the Thread, in counts and states. */
const threadServerSummary = ({ value }: ThreadServerDiagnostics) => {
  const execution = value.execution.ok
    ? (value.execution.value as { daemon?: { connected?: boolean } | null })
        .daemon
    : undefined;
  const agent = value.agent.ok
    ? (value.agent.value as { submissions?: ReadonlyArray<unknown> })
        .submissions
    : undefined;
  const scripts = value.orbSetup.ok
    ? Object.values(value.orbSetup.value as Record<string, unknown>).filter(
        (content) => content !== null,
      ).length
    : undefined;
  return [
    `Execution state: ${
      !value.execution.ok
        ? "unavailable"
        : execution === undefined || execution === null
          ? "no Orb daemon"
          : execution.connected === true
            ? "daemon connected"
            : "daemon not connected"
    }`,
    `Agent state: ${agent === undefined ? "no history" : count(agent.length, "recent prompt")}`,
    `Orb setup scripts: ${scripts === undefined ? "not read" : count(scripts, "file")}`,
    `Worker logs: ${
      value.workerLogs.ok
        ? count(
            (value.workerLogs.value as { lines: ReadonlyArray<unknown> }).lines
              .length,
            "line",
          )
        : "unavailable"
    }`,
  ];
};

/** The parts of a report form, or why they are refused. */
const readForm = async (context: Context<AppEnv>) => {
  const length = Number(context.req.header("content-length") ?? "0");
  if (
    length >
    BUG_REPORT_JSON_MAX_BYTES +
      BUG_REPORT_MAX_IMAGES * BUG_REPORT_IMAGE_MAX_BYTES +
      BUG_REPORT_AUDIO_MAX_BYTES +
      64 * 1024
  )
    return "TOO_LARGE" as const;
  const form = await context.req.formData().catch(() => undefined);
  if (form === undefined) return "INVALID_REQUEST" as const;
  const raw = form.get("report");
  if (typeof raw !== "string") return "INVALID_REQUEST" as const;
  if (new TextEncoder().encode(raw).length > BUG_REPORT_JSON_MAX_BYTES)
    return "TOO_LARGE" as const;
  const report = Option.getOrUndefined(
    Schema.decodeUnknownOption(CreateBugReportRequestSchema)(
      (() => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return undefined;
        }
      })(),
    ),
  );
  if (report === undefined || report.message.trim() === "")
    return "INVALID_REQUEST" as const;
  const images = form.getAll("image");
  if (images.length > BUG_REPORT_MAX_IMAGES) return "TOO_LARGE" as const;
  const files: Array<{ name: string; bytes: Uint8Array; type: string }> = [];
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
  if ((audio !== null) !== (report.diagnostics.dictation !== undefined))
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

const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);

/**
 * `POST /v1/threads/:threadId/bug-reports`, mounted after Thread
 * authorization: a bug report about this Thread. Every chosen diagnostic is
 * redacted before Core keeps or files it.
 */
export const threadBugReportRoutes = new Hono<AppEnv>().post(
  "/:threadId/bug-reports",
  async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const form = await readForm(context);
    if (form === "INVALID_REQUEST") return failure(context, form, 400);
    if (form === "TOO_LARGE") return failure(context, form, 413);
    const threadId = context.req.param("threadId");
    const reporter = context.get("actor") ?? context.get("principal");
    const message = redactBugReportText(form.report.message.trim());
    const diagnostics: Array<BugReportDiagnosticKind> = [];
    const summary: Array<string> = [];
    const bundle: Record<string, unknown> = {};
    const threadAndApp = form.report.diagnostics.threadAndApp;
    if (threadAndApp !== undefined) {
      diagnostics.push("thread-and-app");
      const server = await collectThreadServerDiagnostics(
        context.env,
        context.get("principal").userId,
        threadId as ThreadId,
      );
      summary.push(
        ...threadAndAppSummary(threadAndApp),
        ...threadServerSummary(server),
      );
      bundle.threadAndApp = redactBugReportValue(threadAndApp, server.secrets);
      bundle.thread = redactBugReportValue(server.value, server.secrets);
    }
    const { changes, dictation } = form.report.diagnostics;
    const secrets =
      changes === undefined && dictation === undefined
        ? []
        : await threadSecretValues(context.env, threadId as ThreadId).catch(
            () => [],
          );
    if (changes !== undefined) {
      diagnostics.push("changes");
      const diffs = changes.loaded.filter(
        ({ key }) => Array.isArray(key) && key.includes("diff"),
      ).length;
      summary.push(
        `Changes: ${count(changes.loaded.length - diffs, "range")} and ${count(diffs, "diff")} loaded${changes.truncated ? ", cut to fit" : ""}`,
      );
      bundle.changes = redactBugReportValue(changes, secrets);
    }
    if (dictation !== undefined) {
      diagnostics.push("dictation");
      summary.push(
        `Dictation: ${dictation.outcome}, ${dictation.mode}, ${Math.round(dictation.audioBytes / 1024)} KB of audio`,
      );
      bundle.dictation = redactBugReportValue(dictation, secrets);
    }
    const files = [
      ...(diagnostics.length === 0
        ? []
        : [
            {
              name: "diagnostics.json",
              bytes: new TextEncoder().encode(
                `${JSON.stringify(
                  {
                    report: {
                      threadId,
                      reporterUserId: reporter.userId,
                      deployment: context.env.DX_AUTH_URL,
                      revision: context.env.DX_DEPLOYMENT_REVISION,
                    },
                    ...bundle,
                  },
                  null,
                  2,
                )}\n`,
              ),
              type: "application/json",
            },
          ]),
      ...form.images,
      ...form.audio,
    ];
    const id = newBugReportId();
    const filing = bugReportFiling(context.env);
    try {
      await insertBugReport(db, {
        id,
        reporterUserId: reporter.userId,
        threadId,
        message,
        imageCount: form.images.length,
        diagnostics,
        status: filing === undefined ? "saved" : "filing",
      });
      const bucket = context.env.DX_STORAGE;
      if (bucket !== undefined)
        await Promise.all(
          files.map((file) =>
            bucket.put(`bug-reports/${id}/${file.name}`, file.bytes, {
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
    bugReportLogger.info("Bug report received.", {
      event: "bug_report_received",
      reportId: id,
      threadId,
      imageCount: form.images.length,
      diagnostics,
      filing: filing !== undefined,
    });
    if (filing !== undefined) {
      const report: FiledReport = {
        id,
        threadId,
        reporterUserId: reporter.userId,
        message,
        diagnostics,
        summary,
        imageCount: form.images.length,
      };
      const filed = fileBugReport({
        bindings: context.env,
        filing,
        report,
      }).then((outcome) => settleBugReport(db, id, outcome));
      keepRunning(context, filed);
      await Promise.race([
        filed.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, FILING_WAIT_MS)),
      ]);
    }
    const kept = await readBugReport(db, id);
    if (kept === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    return context.json(
      Schema.encodeUnknownSync(CreateBugReportResponseSchema)({
        status: "success",
        data: kept.report,
      }),
      201,
    );
  },
);

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

const FILE_NAME =
  /^(?:diagnostics\.json|dictation\.wav|image-[1-5]\.(?:png|jpg|gif|webp))$/;

/**
 * Mounted at `/v1/bug-reports`: Your Reports, the signed-in person's own,
 * and one report with its images and diagnostics for its reporter and the
 * deployment's report readers.
 */
export const bugReportRoutes = new Hono<AppEnv>()
  .get("/", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const items = await listBugReports(db, context.get("principal").userId);
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(ListBugReportsResponseSchema)({
        status: "success",
        data: { items },
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
    const listed = await context.env.DX_STORAGE?.list({
      prefix: `bug-reports/${report.id}/`,
      include: ["httpMetadata"],
    });
    const files = (listed?.objects ?? []).flatMap((object) => {
      const name = object.key.slice(`bug-reports/${report.id}/`.length);
      return FILE_NAME.test(name)
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
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(BugReportDetailResponseSchema)({
        status: "success",
        data: { report, files },
      }),
      200,
    );
  })
  .get("/:id/files/:name", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(context, "PERSISTENCE_UNAVAILABLE", 503);
    const name = context.req.param("name");
    const report = FILE_NAME.test(name)
      ? await readableReport(context, db)
      : undefined;
    const object =
      report === undefined
        ? null
        : await context.env.DX_STORAGE?.get(`bug-reports/${report.id}/${name}`);
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
