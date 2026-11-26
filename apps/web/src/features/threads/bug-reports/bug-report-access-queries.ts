import { GetBugReportAccessEndpoint } from "@dx/api";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

/**
 * Whether this person is one of the deployment's report readers, and the
 * central deployment this one shares each report with, if any.
 */
export const bugReportAccessQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ["bug-report-access", userId] as const,
    queryFn: async ({ signal }) =>
      (await dxClient.call(GetBugReportAccessEndpoint, {}, { signal })).data,
    staleTime: 5 * 60_000,
  });
