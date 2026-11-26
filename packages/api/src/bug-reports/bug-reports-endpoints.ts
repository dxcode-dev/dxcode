import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import { ThreadAccessRefusals } from "../threads/thread-access-refusals.js";
import {
  BugReportDetailResponseSchema,
  BugReportFileNameSchema,
  BugReportIdSchema,
  BugReportInvalidResponseSchema,
  BugReportInvestigationFailedResponseSchema,
  BugReportInvestigationResponseSchema,
  BugReportNotFoundResponseSchema,
  BugReportPersistenceUnavailableResponseSchema,
  BugReportRateLimitedResponseSchema,
  BugReportTooLargeResponseSchema,
  CreateBugReportResponseSchema,
  ListAllBugReportsResponseSchema,
  ListBugReportsResponseSchema,
  StartBugReportInvestigationRequestSchema,
} from "./bug-reports.js";

/**
 * The bug report endpoints, apart from `bug-reports.ts`'s schemas, so code
 * that imports only the schemas does not carry the endpoints.
 */

export const BugReportParamsSchema = Schema.Struct({ id: BugReportIdSchema });

const persistenceUnavailable = {
  status: 503,
  schema: BugReportPersistenceUnavailableResponseSchema,
} as const;
const notFound = {
  status: 404,
  schema: BugReportNotFoundResponseSchema,
} as const;

/** What a send refuses: before the form is read, then the form itself. */
const sendRefusals = [
  persistenceUnavailable,
  { status: 429, schema: BugReportRateLimitedResponseSchema },
  { status: 400, schema: BugReportInvalidResponseSchema },
  { status: 413, schema: BugReportTooLargeResponseSchema },
] as const;

/**
 * `POST /v1/bug-reports`: a report from Settings, about no Thread. The form
 * holds `report` (CreateAppBugReportRequest as JSON) and up to five `image`
 * files; an `idempotency-key` header keeps a retried send once.
 */
export const SendAppBugReportEndpoint = defineEndpoint({
  id: "bugReports.send",
  summary: "Send a bug report",
  method: "POST",
  path: "/v1/bug-reports",
  upload: "multipart",
  success: CreateBugReportResponseSchema,
  successStatus: 201,
  refusals: sendRefusals,
});

export const SendThreadBugReportParamsSchema = Schema.Struct({
  threadId: ThreadId,
});

/**
 * `POST /v1/threads/:threadId/bug-reports`: a report about a Thread. The
 * form holds `report` (CreateBugReportRequest as JSON), up to five `image`
 * files, and with Dictation Diagnostics one `audio` WAV.
 */
export const SendThreadBugReportEndpoint = defineEndpoint({
  id: "bugReports.sendForThread",
  summary: "Send a bug report about a Thread",
  method: "POST",
  path: "/v1/threads/:threadId/bug-reports",
  params: SendThreadBugReportParamsSchema,
  upload: "multipart",
  success: CreateBugReportResponseSchema,
  successStatus: 201,
  refusals: [...ThreadAccessRefusals, ...sendRefusals],
});

export const ListBugReportsEndpoint = defineEndpoint({
  id: "bugReports.list",
  summary: "List the person's own bug reports",
  method: "GET",
  path: "/v1/bug-reports",
  success: ListBugReportsResponseSchema,
  refusals: [persistenceUnavailable],
});

/** `before`: the `nextCursor` of the page before. */
export const ListAllBugReportsQuerySchema = Schema.Struct({
  before: Schema.optional(Schema.String),
});

/** Report readers only: anyone else is answered `NOT_FOUND`. */
export const ListAllBugReportsEndpoint = defineEndpoint({
  id: "bugReports.listAll",
  summary: "List every bug report in the deployment",
  method: "GET",
  path: "/v1/bug-reports/all",
  query: ListAllBugReportsQuerySchema,
  success: ListAllBugReportsResponseSchema,
  refusals: [
    persistenceUnavailable,
    notFound,
    { status: 400, schema: BugReportInvalidResponseSchema },
  ],
});

export const GetBugReportEndpoint = defineEndpoint({
  id: "bugReports.get",
  summary: "Read one bug report",
  method: "GET",
  path: "/v1/bug-reports/:id",
  params: BugReportParamsSchema,
  success: BugReportDetailResponseSchema,
  refusals: [persistenceUnavailable, notFound],
});

/** Answers 201 when it starts the Thread, 200 when it was there already. */
export const StartBugReportInvestigationEndpoint = defineEndpoint({
  id: "bugReports.startInvestigation",
  summary: "Start a Thread that investigates a bug report",
  method: "POST",
  path: "/v1/bug-reports/:id/investigation",
  params: BugReportParamsSchema,
  body: StartBugReportInvestigationRequestSchema,
  success: BugReportInvestigationResponseSchema,
  refusals: [
    persistenceUnavailable,
    notFound,
    { status: 400, schema: BugReportInvalidResponseSchema },
    // With the status Thread creation refused with.
    ...([400, 402, 403, 404, 409, 413, 429, 503] as const).map((status) => ({
      status,
      schema: BugReportInvestigationFailedResponseSchema,
    })),
  ],
});

export const BugReportFileParamsSchema = Schema.Struct({
  id: BugReportIdSchema,
  name: BugReportFileNameSchema,
});

/** One file of a report, opened by its URL (`endpointPath`). */
export const GetBugReportFileEndpoint = defineEndpoint({
  id: "bugReports.file",
  summary: "Download a file sent with a bug report",
  method: "GET",
  path: "/v1/bug-reports/:id/files/:name",
  params: BugReportFileParamsSchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [persistenceUnavailable, notFound],
});
