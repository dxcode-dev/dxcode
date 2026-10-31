import {
  type BugReportData,
  BugReportDetailResponseSchema,
  BugReportErrorResponseSchema,
  type CreateBugReportRequest,
  CreateBugReportResponseSchema,
  ListBugReportsResponseSchema,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";

const readJson = async <A>(
  response: Response,
  schema: Schema.Codec<A, unknown>,
): Promise<A> => {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = Schema.decodeUnknownOption(BugReportErrorResponseSchema)(
      body,
    );
    throw new Error(
      Option.isSome(failure)
        ? failure.value.data.message
        : "The bug report could not be sent.",
    );
  }
  return Schema.decodeUnknownPromise(schema)(body).catch(() => {
    throw new Error("The bug report service answered unexpectedly.");
  });
};

/** Your Reports: the signed-in person's bug reports, newest first. */
export const listBugReports = async (signal?: AbortSignal) =>
  (
    await readJson(
      await sameOriginFetch("/v1/bug-reports", {
        headers: { accept: "application/json" },
        signal,
      }),
      ListBugReportsResponseSchema,
    )
  ).data.items;

export interface SendBugReportInput {
  readonly threadId: ThreadId;
  readonly report: CreateBugReportRequest;
  readonly images: ReadonlyArray<File>;
  /** The dictation's audio, with Dictation Diagnostics. */
  readonly audio?: Blob;
}

export const sendBugReport = async ({
  threadId,
  report,
  images,
  audio,
}: SendBugReportInput): Promise<BugReportData> => {
  const form = new FormData();
  form.set("report", JSON.stringify(report));
  for (const image of images) form.append("image", image, image.name);
  if (audio !== undefined)
    form.append(
      "audio",
      new Blob([audio], { type: "audio/wav" }),
      "dictation.wav",
    );
  return (
    await readJson(
      await sameOriginFetch(
        `/v1/threads/${encodeURIComponent(threadId)}/bug-reports`,
        {
          method: "POST",
          body: form,
          headers: { accept: "application/json" },
        },
      ),
      CreateBugReportResponseSchema,
    )
  ).data;
};

export const bugReportKeys = {
  mine: (userId: UserId) => ["bug-reports", userId] as const,
};

/** Polls while a report is still filing, so its issue link appears. */
export const bugReportsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: bugReportKeys.mine(userId),
    queryFn: ({ signal }) => listBugReports(signal),
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.some((report) => report.status === "filing")
        ? 5_000
        : false,
  });

export const sendBugReportMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationFn: sendBugReport,
    onSuccess: (report) => {
      queryClient.setQueryData<ReadonlyArray<BugReportData>>(
        bugReportKeys.mine(userId),
        (current) =>
          current === undefined
            ? undefined
            : [report, ...current.filter(({ id }) => id !== report.id)],
      );
      void queryClient.invalidateQueries({
        queryKey: bugReportKeys.mine(userId),
      });
    },
  });

/** One report and its files, for its reporter and report readers. */
export const bugReportQueryOptions = (userId: UserId, reportId: string) =>
  queryOptions({
    queryKey: [...bugReportKeys.mine(userId), "report", reportId] as const,
    queryFn: async ({ signal }) =>
      (
        await readJson(
          await sameOriginFetch(
            `/v1/bug-reports/${encodeURIComponent(reportId)}`,
            { headers: { accept: "application/json" }, signal },
          ),
          BugReportDetailResponseSchema,
        )
      ).data,
    staleTime: 30_000,
    retry: false,
  });

/** Where a report's file opens; the request carries the dx session. */
export const bugReportFileUrl = (reportId: string, name: string) =>
  `/v1/bug-reports/${encodeURIComponent(reportId)}/files/${encodeURIComponent(name)}`;
