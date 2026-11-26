import {
  DeleteThreadGitHubSubscriptionEndpoint,
  DeleteThreadScheduleEndpoint,
  type ThreadAutomationsData,
  UpdateThreadGitHubSubscriptionEndpoint,
  UpdateThreadScheduleEndpoint,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import { automationKeys } from "./automations-queries.js";

/**
 * Pausing, resuming, and deleting automations, apart from the queries the
 * Thread page loads first: only the listeners sheet loads these.
 */

export type AutomationAction =
  | { readonly kind: "schedule"; readonly enabled?: boolean }
  | {
      readonly kind: "github";
      readonly id: string;
      readonly enabled?: boolean;
    };

const automationActionRequest = (
  threadId: ThreadId,
  action: AutomationAction,
) => {
  if (action.kind === "schedule")
    return action.enabled === undefined
      ? dxClient.call(DeleteThreadScheduleEndpoint, { params: { threadId } })
      : dxClient.call(UpdateThreadScheduleEndpoint, {
          params: { threadId },
          body: { enabled: action.enabled },
        });
  const params = { threadId, id: action.id };
  return action.enabled === undefined
    ? dxClient.call(DeleteThreadGitHubSubscriptionEndpoint, { params })
    : dxClient.call(UpdateThreadGitHubSubscriptionEndpoint, {
        params,
        body: { enabled: action.enabled },
      });
};

/** Pauses, resumes, or (without `enabled`) deletes one automation. */
export const useAutomationAction = (threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...automationKeys.thread(threadId), "action"],
    mutationFn: async (action: AutomationAction) =>
      (await automationActionRequest(threadId, action)).data,
    onSuccess: (data: ThreadAutomationsData) =>
      client.setQueryData(automationKeys.thread(threadId), data),
  });
};
