import {
  BugReportAccessResponseSchema,
  type BugReportData,
  BugReportDetailResponseSchema,
  BugReportErrorResponseSchema,
  type BugReportInvestigation,
  BugReportInvestigationFailedResponseSchema,
  BugReportInvestigationResponseSchema,
  type ChoicesData,
  type CreateAppBugReportRequest,
  type CreateBugReportRequest,
  CreateBugReportResponseSchema,
  ListAllBugReportsResponseSchema,
  ListBugReportsResponseSchema,
  type PersonalComposerDefaultsData,
  type StartBugReportInvestigationRequest,
} from "@dx/api";
import {
  CLAUDE_CODE_DEFAULT_EFFORT,
  isClaudeCodeModel,
  type ModelConnectionId,
  type ModelId,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import {
  infiniteQueryOptions,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { startingMode, startingModel } from "../../../shared/composer-start.js";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";
import { composerDefaultsQueryOptions } from "../../settings/composer/composer-defaults-queries.js";
import { modelRoutingChoicesQueryOptions } from "../../settings/model-routing/model-routing-queries.js";
import { claudePlanPick } from "../claude-code-mode-options.js";
import { reasoningModeId } from "../new-thread-modal-utils.js";

const readJson = async <A>(
  response: Response,
  schema: Schema.Codec<A, unknown>,
): Promise<A> => {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = Schema.decodeUnknownOption(
      Schema.Union([
        BugReportErrorResponseSchema,
        BugReportInvestigationFailedResponseSchema,
      ]),
    )(body);
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

/**
 * A report about a Thread, or, from Settings, about no Thread and with App
 * Diagnostics at most.
 */
export type SendBugReportInput =
  | {
      readonly threadId: ThreadId;
      readonly report: CreateBugReportRequest;
      readonly images: ReadonlyArray<File>;
      /** The dictation's audio, with Dictation Diagnostics. */
      readonly audio?: Blob;
    }
  | {
      readonly threadId?: undefined;
      readonly report: CreateAppBugReportRequest;
      readonly images: ReadonlyArray<File>;
      readonly audio?: undefined;
    };

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
        threadId === undefined
          ? "/v1/bug-reports"
          : `/v1/threads/${encodeURIComponent(threadId)}/bug-reports`,
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

export const bugReportsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: bugReportKeys.mine(userId),
    queryFn: ({ signal }) => listBugReports(signal),
    staleTime: 30_000,
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

/**
 * What an investigating Thread runs on: what the New Thread composer would
 * start with, from the person's remembered mode or model and their first
 * enabled Claude plan. Core applies their model and plan rules again.
 */
export const investigationRequest = (
  remembered: PersonalComposerDefaultsData | undefined,
  choices: ChoicesData | undefined,
): StartBugReportInvestigationRequest => {
  const model = startingModel(
    remembered?.model ?? null,
    choices?.models.map(({ canonical }) => canonical),
  );
  if (model === undefined)
    return {
      selection: {
        kind: "mode",
        profileId: "default",
        mode: reasoningModeId(startingMode(remembered?.mode ?? null)),
      },
    };
  const claudePlan = isClaudeCodeModel(model)
    ? claudePlanPick(choices, undefined).current?.connectionId
    : undefined;
  return {
    selection: {
      kind: "model",
      model: model as ModelId,
      ...(isClaudeCodeModel(model)
        ? { thinking: CLAUDE_CODE_DEFAULT_EFFORT }
        : {}),
    },
    ...(claudePlan === undefined
      ? {}
      : { claudeConnectionId: claudePlan as ModelConnectionId }),
  };
};

/**
 * Investigate: starts the one Thread that investigates the report, as this
 * person on their own mode and plan, or finds the one it has.
 */
export const startBugReportInvestigationMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationFn: async (reportId: string): Promise<BugReportInvestigation> => {
      // Unloaded defaults start the composer's defaults, as a new composer does.
      const [remembered, choices] = await Promise.all([
        queryClient
          .ensureQueryData(composerDefaultsQueryOptions(userId))
          .catch(() => undefined),
        queryClient
          .ensureQueryData(modelRoutingChoicesQueryOptions(userId))
          .catch(() => undefined),
      ]);
      return (
        await readJson(
          await sameOriginFetch(
            `/v1/bug-reports/${encodeURIComponent(reportId)}/investigation`,
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
              },
              body: JSON.stringify(investigationRequest(remembered, choices)),
            },
          ),
          BugReportInvestigationResponseSchema,
        )
      ).data;
    },
    onSettled: (_data, _error, reportId) =>
      queryClient.invalidateQueries({
        queryKey: [...bugReportKeys.mine(userId), "report", reportId],
      }),
  });

/**
 * Whether this person is one of the deployment's report readers, and the
 * central deployment this one shares each report with, if any.
 */
export const bugReportAccessQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ["bug-report-access", userId] as const,
    queryFn: async ({ signal }) =>
      (
        await readJson(
          await sameOriginFetch("/v1/bug-reports/access", {
            headers: { accept: "application/json" },
            signal,
          }),
          BugReportAccessResponseSchema,
        )
      ).data,
    staleTime: 5 * 60_000,
  });

/** All Bug Reports: every report, newest first, for report readers. */
export const allBugReportsQueryOptions = (userId: UserId) =>
  infiniteQueryOptions({
    queryKey: ["bug-reports-all", userId] as const,
    queryFn: async ({ pageParam, signal }) =>
      (
        await readJson(
          await sameOriginFetch(
            pageParam === undefined
              ? "/v1/bug-reports/all"
              : `/v1/bug-reports/all?before=${encodeURIComponent(pageParam)}`,
            { headers: { accept: "application/json" }, signal },
          ),
          ListAllBugReportsResponseSchema,
        )
      ).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 30_000,
  });
