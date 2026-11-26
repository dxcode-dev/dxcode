import {
  GetThreadAutomationsEndpoint,
  type ThreadAutomationsData,
  UpdateTimeZoneEndpoint,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

const updateTimeZone = async (timeZone: string) =>
  (await dxClient.call(UpdateTimeZoneEndpoint, { body: { timeZone } })).data;

export const automationKeys = {
  all: ["thread-automations"] as const,
  thread: (threadId: ThreadId) => ["thread-automations", threadId] as const,
};

/**
 * The Thread's schedule and GitHub subscriptions, for its owner. A
 * `thread.invalidated` hint refetches it, so what an agent's turn set up
 * shows when the turn ends, as does a firing.
 */
export const threadAutomationsQueryOptions = (threadId: ThreadId) =>
  queryOptions({
    queryKey: automationKeys.thread(threadId),
    queryFn: async ({ signal }) =>
      (
        await dxClient.call(
          GetThreadAutomationsEndpoint,
          { params: { threadId } },
          { signal },
        )
      ).data,
    staleTime: 30_000,
  });

export const useThreadAutomations = (threadId: ThreadId, enabled = true) =>
  useQuery({ ...threadAutomationsQueryOptions(threadId), enabled });

export const hasThreadAutomations = (data: ThreadAutomationsData | undefined) =>
  data !== undefined &&
  (data.schedule !== undefined || data.githubSubscriptions.length > 0);

export type AutomationView = "issues" | "pulls" | "ci" | "listeners";

/** The entries the Thread has, in header order, with their names. */
export const automationViews = (data: ThreadAutomationsData | undefined) =>
  data === undefined
    ? []
    : [
        ...(data.issues.length === 0
          ? []
          : [{ view: "issues" as const, label: "Issues" }]),
        ...(data.pullRequests.length === 0
          ? []
          : [{ view: "pulls" as const, label: "Pull requests" }]),
        ...(data.ciRuns.length === 0
          ? []
          : [{ view: "ci" as const, label: "CI" }]),
        ...(hasThreadAutomations(data)
          ? [
              {
                view: "listeners" as const,
                label: "Schedule and GitHub events",
              },
            ]
          : []),
      ];

export const invalidateThreadAutomations = (
  client: QueryClient,
  threadId: ThreadId,
) => client.invalidateQueries({ queryKey: automationKeys.thread(threadId) });

export const invalidateAllThreadAutomations = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: automationKeys.all });

/** Records the browser's zone, where schedules without DTSTART run. */
export const recordBrowserTimeZone = () =>
  updateTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone).catch(
    () => undefined,
  );
