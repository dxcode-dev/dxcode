import {
  AddFeedbackWidgetOriginEndpoint,
  DisableFeedbackWidgetEndpoint,
  EnableFeedbackWidgetEndpoint,
  type FeedbackWidgetData,
  GetFeedbackWidgetEndpoint,
  RemoveFeedbackWidgetOriginEndpoint,
} from "@dx/api";
import type { ProjectId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { projectKeys } from "./project-queries.js";

// Project Settings → Feedback Widget, apart from the personal embed the app
// shell reads, so the Thread page's first load carries none of it.

export const feedbackWidgetKey = (userId: UserId, projectId: ProjectId) =>
  [...projectKeys.detail(userId, projectId), "feedback-widget"] as const;

export const feedbackWidgetQueryOptions = (
  userId: UserId,
  projectId: ProjectId,
) =>
  queryOptions({
    queryKey: feedbackWidgetKey(userId, projectId),
    queryFn: async ({ signal }): Promise<FeedbackWidgetData> =>
      (
        await dxClient.call(
          GetFeedbackWidgetEndpoint,
          { params: { projectId } },
          { signal },
        )
      ).data,
    staleTime: 30_000,
  });

export type FeedbackWidgetChange =
  | { readonly kind: "enable" }
  | { readonly kind: "disable" }
  | { readonly kind: "add-origin"; readonly origin: string }
  | { readonly kind: "remove-origin"; readonly origin: string };

const changeWidget = (projectId: ProjectId, change: FeedbackWidgetChange) => {
  const params = { projectId };
  switch (change.kind) {
    case "enable":
      return dxClient.call(EnableFeedbackWidgetEndpoint, { params });
    case "disable":
      return dxClient.call(DisableFeedbackWidgetEndpoint, { params });
    case "add-origin":
      return dxClient.call(AddFeedbackWidgetOriginEndpoint, {
        params,
        body: { origin: change.origin },
      });
    case "remove-origin":
      return dxClient.call(RemoveFeedbackWidgetOriginEndpoint, {
        params,
        body: { origin: change.origin },
      });
  }
};

export const changeFeedbackWidgetMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...feedbackWidgetKey(userId, projectId), "change"],
    mutationFn: async (change: FeedbackWidgetChange) =>
      (await changeWidget(projectId, change)).data,
    onSuccess: (data) =>
      queryClient.setQueryData(feedbackWidgetKey(userId, projectId), data),
  });
