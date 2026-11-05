import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";
import {
  BugReportDiagnosticKindSchema,
  BugReportIdSchema,
  CreateBugReportRequestSchema,
} from "./bug-reports.js";

/*
 * Bug report forwarding between deployments (#1661). Only Core uses these, so
 * they live apart from the schemas the web app loads with the Thread page.
 */

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** A sender's name, as its intake key carries it. */
export const BugReportSenderSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
);

/**
 * The `report` part of `POST /api/bug-reports/intake`: a report another
 * deployment kept and forwards to this one. Its `file` parts are the
 * report's images, `diagnostics.json`, and dictation audio, by the names
 * the sender keeps them under.
 */
export const BugReportIntakeRequestSchema = Schema.Struct({
  message: CreateBugReportRequestSchema.fields.message,
  diagnostics: Schema.Array(BugReportDiagnosticKindSchema).check(
    Schema.isMaxLength(4),
  ),
  source: Schema.Struct({
    /** The sending deployment's origin, as it states it. */
    origin: Text(256).check(Schema.isPattern(/^https?:\/\/[^\s/?#]+$/)),
    /** The report's ID on the sending deployment. */
    reportId: BugReportIdSchema,
    threadId: Schema.optional(ThreadId),
    createdAt: Text(64),
  }),
});
export type BugReportIntakeRequest = typeof BugReportIntakeRequestSchema.Type;

/** `POST /api/bug-reports/intake`: the report as this deployment keeps it. */
export const BugReportIntakeResponseSchema = successResponse(
  Schema.Struct({ id: BugReportIdSchema }),
);
