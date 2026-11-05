import { ModelConnectionId, ThreadId, ThreadModelSelection } from "@dx/domain";
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

/**
 * The diagnostics a person can choose to send: from a Thread, Thread and App
 * Diagnostics, Diff, and Dictation; from Settings, App Diagnostics alone.
 */
export const BugReportDiagnosticKindSchema = Schema.Literals([
  "thread-and-app",
  "app",
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

const appDiagnosticsFields = {
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
};

/**
 * App Diagnostics, sent from Settings: the web app's state, recent errors,
 * failed requests, and connection events, with nothing about a Thread.
 */
export const BugReportAppDiagnosticsSchema =
  Schema.Struct(appDiagnosticsFields);
export type BugReportAppDiagnostics = typeof BugReportAppDiagnosticsSchema.Type;

/**
 * Thread and App Diagnostics as the web app collects them: App Diagnostics
 * and the Thread's transcript. Core adds what it holds for the Thread.
 */
export const BugReportThreadAndAppDiagnosticsSchema = Schema.Struct({
  ...appDiagnosticsFields,
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
 * The `report` part of `POST /v1/bug-reports`, sent from Settings: a report
 * about no Thread, whose `image` parts are the attached images.
 */
export const CreateAppBugReportRequestSchema = Schema.Struct({
  message: CreateBugReportRequestSchema.fields.message,
  diagnostics: Schema.Struct({
    app: Schema.optional(BugReportAppDiagnosticsSchema),
  }),
});
export type CreateAppBugReportRequest =
  typeof CreateAppBugReportRequestSchema.Type;

/**
 * A bug report as this deployment keeps it. It is never filed anywhere:
 * its reporter and the deployment's report readers open it in dx, and
 * their agents read it with the bug report tools.
 */
export const BugReportDataSchema = Schema.Struct({
  id: BugReportIdSchema,
  /** Absent for a report sent from Settings. */
  threadId: Schema.optional(ThreadId),
  message: Text(BUG_REPORT_MESSAGE_MAX_LENGTH),
  createdAt: Schema.String,
  imageCount: Count,
  diagnostics: Schema.Array(BugReportDiagnosticKindSchema),
  /**
   * Present on a report another deployment forwarded here: the sender its
   * intake key names, and the origin the sender gave.
   */
  source: Schema.optional(
    Schema.Struct({ sender: Text(64), origin: Text(256) }),
  ),
});
export type BugReportData = typeof BugReportDataSchema.Type;

/**
 * `POST /v1/threads/:threadId/bug-reports` and `POST /v1/bug-reports`: the
 * report as Core keeps it.
 */
export const CreateBugReportResponseSchema =
  successResponse(BugReportDataSchema);

/** `GET /v1/bug-reports`: the signed-in person's reports, newest first. */
export const ListBugReportsResponseSchema = successResponse(
  Schema.Struct({ items: Schema.Array(BugReportDataSchema) }),
);

/**
 * `GET /v1/bug-reports/access`: whether this person reads every report, and
 * the host of the central deployment this one shares each report with, when
 * it shares them.
 */
export const BugReportAccessResponseSchema = successResponse(
  Schema.Struct({
    reader: Schema.Boolean,
    sharedWith: Schema.optional(Text(256)),
  }),
);

/** A report in All Bug Reports, with who sent it. */
export const BugReportListItemSchema = Schema.Struct({
  ...BugReportDataSchema.fields,
  reporter: Schema.Struct({
    /** Their display name, or their username without one. */
    name: Schema.String,
    username: Schema.optional(Schema.String),
    you: Schema.Boolean,
  }),
});
export type BugReportListItem = typeof BugReportListItemSchema.Type;

/**
 * `GET /v1/bug-reports/all`: every report this deployment keeps, newest
 * first, for its report readers alone. `nextCursor` is the `before` of the
 * next page.
 */
export const ListAllBugReportsResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(BugReportListItemSchema),
    nextCursor: Schema.optional(BugReportIdSchema),
  }),
);

/** A file Core keeps with a report: an image or `diagnostics.json`. */
export const BugReportFileSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+\.[a-z]+$/)),
  size: Count,
  contentType: Text(128),
});
export type BugReportFile = typeof BugReportFileSchema.Type;

/**
 * The Thread investigating a report. `threadId` is absent when it is
 * another person's Thread that the person asking cannot open.
 */
export const BugReportInvestigationSchema = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});

/**
 * `GET /v1/bug-reports/:id`: one report and its files, for its reporter and
 * the deployment's report readers. Each file is at
 * `/v1/bug-reports/:id/files/:name`.
 */
export const BugReportDetailResponseSchema = successResponse(
  Schema.Struct({
    report: BugReportDataSchema,
    files: Schema.Array(BugReportFileSchema),
    /** The Thread investigating the report, while it exists. */
    investigation: Schema.optional(BugReportInvestigationSchema),
  }),
);
export type BugReportDetail =
  (typeof BugReportDetailResponseSchema.Type)["data"];

/**
 * The body of `POST /v1/bug-reports/:id/investigation`: the mode or model,
 * and Claude plan, the investigating Thread runs on, as the New Thread
 * composer would start it. Core picks its Project.
 */
export const StartBugReportInvestigationRequestSchema = Schema.Struct({
  selection: Schema.optional(ThreadModelSelection),
  claudeConnectionId: Schema.optional(ModelConnectionId),
});
export type StartBugReportInvestigationRequest =
  typeof StartBugReportInvestigationRequestSchema.Type;

/**
 * `POST /v1/bug-reports/:id/investigation`: the Thread investigating the
 * report, started now (201) or already there (200). A report has at most
 * one; it runs as the person who started it.
 */
export const BugReportInvestigationResponseSchema = successResponse(
  Schema.Struct({
    ...BugReportInvestigationSchema.fields,
    started: Schema.Boolean,
  }),
);
export type BugReportInvestigation =
  (typeof BugReportInvestigationResponseSchema.Type)["data"];

/**
 * The investigating Thread could not be started: Thread creation refused it,
 * for the reason in `message` (a Claude plan used up, a Project the person
 * cannot start Threads in).
 */
export const BugReportInvestigationFailedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVESTIGATION_NOT_STARTED"),
    message: Schema.String,
    requestId: Schema.String,
  }),
});

export const BugReportErrorResponseSchema = Schema.Union([
  errorResponse("INVALID_REQUEST", "The bug report is invalid."),
  errorResponse("TOO_LARGE", "The bug report is too large."),
  errorResponse("NOT_FOUND", "Bug report not found."),
  errorResponse(
    "PERSISTENCE_UNAVAILABLE",
    "Persistence is temporarily unavailable.",
  ),
]);
