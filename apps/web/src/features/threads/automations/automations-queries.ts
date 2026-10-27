import {
  type ThreadAutomationsData,
  ThreadAutomationsResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { request, updateTimeZone } from "../../../shared/api/client.js";

export const automationKeys = {
  all: ["thread-automations"] as const,
  thread: (threadId: ThreadId) => ["thread-automations", threadId] as const,
};

const base = (threadId: ThreadId) =>
  `/v1/threads/${encodeURIComponent(threadId)}/automations`;

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
        await request(base(threadId), ThreadAutomationsResponseSchema, {
          signal,
        })
      ).data,
    staleTime: 30_000,
  });

export const useThreadAutomations = (threadId: ThreadId, enabled = true) =>
  useQuery({ ...threadAutomationsQueryOptions(threadId), enabled });

export const hasThreadAutomations = (data: ThreadAutomationsData | undefined) =>
  data !== undefined &&
  (data.schedule !== undefined || data.githubSubscriptions.length > 0);

export type AutomationView = "pulls" | "ci" | "listeners";

/** The entries the Thread has, in header order, with their names. */
export const automationViews = (data: ThreadAutomationsData | undefined) =>
  data === undefined
    ? []
    : [
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

export type AutomationAction =
  | { readonly kind: "schedule"; readonly enabled?: boolean }
  | {
      readonly kind: "github";
      readonly id: string;
      readonly enabled?: boolean;
    };

/** Pauses, resumes, or (without `enabled`) deletes one automation. */
export const useAutomationAction = (threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...automationKeys.thread(threadId), "action"],
    mutationFn: async (action: AutomationAction) =>
      (
        await request(
          action.kind === "schedule"
            ? `${base(threadId)}/schedule`
            : `${base(threadId)}/github/${encodeURIComponent(action.id)}`,
          ThreadAutomationsResponseSchema,
          action.enabled === undefined
            ? { method: "DELETE" }
            : {
                method: "PATCH",
                body: JSON.stringify({ enabled: action.enabled }),
              },
        )
      ).data,
    onSuccess: (data: ThreadAutomationsData) =>
      client.setQueryData(automationKeys.thread(threadId), data),
  });
};

/** Records the browser's zone, where schedules without DTSTART run. */
export const recordBrowserTimeZone = () =>
  updateTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone).catch(
    () => undefined,
  );
