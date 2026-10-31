import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

export const BUG_REPORT_MESSAGE_MAX_LENGTH = 10_000;
export const BUG_REPORT_MAX_IMAGES = 5;
export const BUG_REPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** The `report` form field: the message and the diagnostics chosen. */
export const BUG_REPORT_JSON_MAX_BYTES = 4 * 1024 * 1024;
/** The `audio` part: the dictation Dictation Diagnostics carry, as WAV. */
export const BUG_REPORT_AUDIO_MAX_BYTES = 30 * 1024 * 1024;

export const BugReportIdSchema = Schema.String.check(
  Schema.isPattern(/^bug_[0-9a-f]{32}$/),
);
export type BugReportId = typeof BugReportIdSchema.Type;

/** The diagnostics a person can choose to send. */
export const BugReportDiagnosticKindSchema = Schema.Literals([
  "thread-and-app",
  "changes",
  "dictation",
]);
export type BugReportDiagnosticKind = typeof BugReportDiagnosticKindSchema.Type;

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** One line the web app logged: console errors and warnings, uncaught errors. */
export const BugReportAppLogSchema = Schema.Struct({
  at: Text(64),
  level: Schema.Literals(["error", "warn"]),
  message: Text(4_000),
});

/** A dx request that failed: no response, or a status of 400 or more. */
export const BugReportFailedRequestSchema = Schema.Struct({
  at: Text(64),
  method: Text(16),
  /** The path without its query string. */
  path: Text(1_024),
  /** Absent when no response arrived. */
  status: Schema.optional(Count),
  requestId: Schema.optional(Text(128)),
  durationMs: Count,
});

/** A change in the app's realtime connection. */
export const BugReportConnectionEventSchema = Schema.Struct({
  at: Text(64),
  event: Text(64),
  detail: Schema.optional(Text(512)),
});

/**
 * Thread and App Diagnostics as the web app collects them. Core adds what it
 * holds for the Thread before it files the report.
 */
export const BugReportThreadAndAppDiagnosticsSchema = Schema.Struct({
  app: Schema.Struct({
    path: Text(2_048),
    userAgent: Text(1_024),
    viewport: Text(64),
    online: Schema.Boolean,
    visibility: Text(32),
    revision: Schema.optional(Text(128)),
  }),
  logs: Schema.Array(BugReportAppLogSchema).check(Schema.isMaxLength(200)),
  failedRequests: Schema.Array(BugReportFailedRequestSchema).check(
    Schema.isMaxLength(100),
  ),
  connection: Schema.Array(BugReportConnectionEventSchema).check(
    Schema.isMaxLength(100),
  ),
  /** The Thread as its JSON export writes it. */
  transcript: Schema.optional(Schema.Unknown),
});
export type BugReportThreadAndAppDiagnostics =
  typeof BugReportThreadAndAppDiagnosticsSchema.Type;

/**
 * Diff Diagnostics, from an open Changes pane: how it shows the changes
 * (range, diff style, wrapping, sort, expanded files) and the changes and
 * diffs it has loaded, patches included.
 */
export const BugReportChangesDiagnosticsSchema = Schema.Struct({
  view: Schema.Struct({
    range: Text(256),
    diffStyle: Text(16),
    overflow: Text(16),
    sortByName: Schema.Boolean,
    expanded: Schema.Array(Text(2_048)).check(Schema.isMaxLength(500)),
  }),
  /** Each loaded Changes query, as its key and data. */
  loaded: Schema.Array(
    Schema.Struct({ key: Schema.Unknown, data: Schema.Unknown }),
  ).check(Schema.isMaxLength(200)),
  /** Patches cut to fit the report. */
  truncated: Schema.Boolean,
});
export type BugReportChangesDiagnostics =
  typeof BugReportChangesDiagnosticsSchema.Type;

/**
 * Dictation Diagnostics: the latest dictation in the Thread. Its audio is
 * the form's `audio` part.
 */
export const BugReportDictationDiagnosticsSchema = Schema.Struct({
  transcript: Schema.optional(Text(50_000)),
  outcome: Schema.Literals(["completed", "failed"]),
  error: Schema.optional(Text(1_000)),
  /** `live` streamed while recording; `upload` sent the recording after. */
  mode: Schema.Literals(["live", "upload"]),
  jobId: Text(128),
  startedAt: Text(64),
  finishedAt: Text(64),
  audioBytes: Count,
  audioType: Text(64),
});
export type BugReportDictationDiagnostics =
  typeof BugReportDictationDiagnosticsSchema.Type;

/**
 * The `report` part of `POST /v1/threads/:threadId/bug-reports`, a
 * multipart form whose `image` parts are the attached images and whose
 * `audio` part, with Dictation Diagnostics, is the dictation's audio.
 */
export const CreateBugReportRequestSchema = Schema.Struct({
  message: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BUG_REPORT_MESSAGE_MAX_LENGTH),
  ),
  diagnostics: Schema.Struct({
    threadAndApp: Schema.optional(BugReportThreadAndAppDiagnosticsSchema),
    changes: Schema.optional(BugReportChangesDiagnosticsSchema),
    dictation: Schema.optional(BugReportDictationDiagnosticsSchema),
  }),
});
export type CreateBugReportRequest = typeof CreateBugReportRequestSchema.Type;

/**
 * Where a report is: `filing` while Core files it, `filed` as a new issue,
 * `commented` on an open issue it duplicates, `saved` when this deployment
 * files reports nowhere, and `failed` when filing failed.
 */
export const BugReportStatusSchema = Schema.Literals([
  "filing",
  "filed",
  "commented",
  "saved",
  "failed",
]);
export type BugReportStatus = typeof BugReportStatusSchema.Type;

export const BugReportDataSchema = Schema.Struct({
  id: BugReportIdSchema,
  threadId: ThreadId,
  message: Text(BUG_REPORT_MESSAGE_MAX_LENGTH),
  createdAt: Schema.String,
  status: BugReportStatusSchema,
  issue: Schema.optional(
    Schema.Struct({
      number: Schema.Int.check(Schema.isGreaterThan(0)),
      url: Text(2_048),
    }),
  ),
  imageCount: Count,
  diagnostics: Schema.Array(BugReportDiagnosticKindSchema),
});
export type BugReportData = typeof BugReportDataSchema.Type;

/** `POST /v1/threads/:threadId/bug-reports`: the report, now filing. */
export const CreateBugReportResponseSchema =
  successResponse(BugReportDataSchema);

/** `GET /v1/bug-reports`: the signed-in person's reports, newest first. */
export const ListBugReportsResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(BugReportDataSchema) }),
);

/** A file Core keeps with a report: an image or `diagnostics.json`. */
export const BugReportFileSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+\.[a-z]+$/)),
  size: Count,
  contentType: Text(128),
});
export type BugReportFile = typeof BugReportFileSchema.Type;

/**
 * `GET /v1/bug-reports/:id`: one report and its files, for its reporter and
 * the deployment's report readers. Each file is at
 * `/v1/bug-reports/:id/files/:name`.
 */
export const BugReportDetailResponseSchema = successResponse(
  Schema.Struct({
    report: BugReportDataSchema,
    files: Schema.Array(BugReportFileSchema),
  }),
);
export type BugReportDetail =
  (typeof BugReportDetailResponseSchema.Type)["data"];

export const BugReportErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "The bug report is invalid."),
  errorResponse("TOO_LARGE", "The bug report is too large."),
  errorResponse("NOT_FOUND", "Bug report not found."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
