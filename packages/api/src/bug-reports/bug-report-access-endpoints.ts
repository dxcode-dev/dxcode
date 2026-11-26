import { defineEndpoint } from "../http/endpoint.js";
import {
  BugReportAccessResponseSchema,
  BugReportPersistenceUnavailableResponseSchema,
} from "./bug-reports.js";

/**
 * Whether the person reads every report. Apart from the other bug report
 * endpoints: the sidebar's account menu asks on first load.
 */
export const GetBugReportAccessEndpoint = defineEndpoint({
  id: "bugReports.access",
  summary: "Whether the person may read every bug report",
  method: "GET",
  path: "/v1/bug-reports/access",
  success: BugReportAccessResponseSchema,
  refusals: [
    { status: 503, schema: BugReportPersistenceUnavailableResponseSchema },
  ],
});
