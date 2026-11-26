import {
  type BugReportData,
  type BugReportInvestigation,
  type ChoicesData,
  type CreateAppBugReportRequest,
  type CreateBugReportRequest,
  GetBugReportEndpoint,
  GetBugReportFileEndpoint,
  ListAllBugReportsEndpoint,
  ListBugReportsEndpoint,
  type PersonalComposerDefaultsData,
  SendAppBugReportEndpoint,
  SendThreadBugReportEndpoint,
  StartBugReportInvestigationEndpoint,
  type StartBugReportInvestigationRequest,
} from "@dx/api";
import { endpointPath, reasoningModeId } from "@dx/client";
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
import { ApiError, dxClient } from "../../../shared/api/client.js";
import { startingMode, startingModel } from "../../../shared/composer-start.js";
import { composerDefaultsQueryOptions } from "../../settings/composer/composer-defaults-queries.js";
import { modelRoutingChoicesQueryOptions } from "../../settings/model-routing/model-routing-queries.js";
import { claudePlanPick } from "../claude-code-mode-options.js";

/** Your Reports: the signed-in person's bug reports, newest first. */
export const listBugReports = async (signal?: AbortSignal) =>
  (await dxClient.call(ListBugReportsEndpoint, {}, { signal })).data.items;

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
      /** The same on every try of one send, so a retry keeps it once. */
      readonly sendKey?: string;
    }
  | {
      readonly threadId?: undefined;
      readonly report: CreateAppBugReportRequest;
      readonly images: ReadonlyArray<File>;
      readonly audio?: undefined;
      /** The same on every try of one send, so a retry keeps it once. */
      readonly sendKey?: string;
    };

export const sendBugReport = async ({
  threadId,
  report,
  images,
  audio,
  sendKey,
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
  const options =
    sendKey === undefined ? {} : { headers: { "idempotency-key": sendKey } };
  const sent =
    threadId === undefined
      ? dxClient.call(SendAppBugReportEndpoint, { body: form }, options)
      : dxClient.call(
          SendThreadBugReportEndpoint,
          { params: { threadId }, body: form },
          options,
        );
  return (
    await sent.catch((error: unknown) => {
      // An answer that is none of the route's refusals says no more.
      throw error instanceof ApiError && !error.hasValidatedPayload
        ? new Error("The bug report could not be sent.")
        : error;
    })
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
        await dxClient.call(
          GetBugReportEndpoint,
          { params: { id: reportId } },
          { signal },
        )
      ).data,
    staleTime: 30_000,
    retry: false,
  });

/** Where a report's file opens; the request carries the dx session. */
export const bugReportFileUrl = (reportId: string, name: string) =>
  endpointPath(GetBugReportFileEndpoint, { params: { id: reportId, name } });

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
        await dxClient.call(StartBugReportInvestigationEndpoint, {
          params: { id: reportId },
          body: investigationRequest(remembered, choices),
        })
      ).data;
    },
    onSettled: (_data, _error, reportId) =>
      queryClient.invalidateQueries({
        queryKey: [...bugReportKeys.mine(userId), "report", reportId],
      }),
  });

/** All Bug Reports: every report, newest first, for report readers. */
export const allBugReportsQueryOptions = (userId: UserId) =>
  infiniteQueryOptions({
    queryKey: ["bug-reports-all", userId] as const,
    queryFn: async ({ pageParam, signal }) =>
      (
        await dxClient.call(
          ListAllBugReportsEndpoint,
          { query: pageParam === undefined ? {} : { before: pageParam } },
          { signal },
        )
      ).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 30_000,
  });
