import {
  type FeedbackWidgetData,
  GetFeedbackWidgetResponseSchema,
  GetPersonalFeedbackWidgetEmbedResponseSchema,
  type PersonalFeedbackWidgetEmbedData,
} from "@dx/api";
import {
  FEEDBACK_WIDGET_FEATURE,
  type ProjectId,
  type UserId,
} from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";
import { useIdentity } from "../../shared/auth/auth-context.js";
import { personalExperimentalFeaturesQueryOptions } from "../settings/experimental-features/experimental-features-queries.js";
import { projectKeys } from "./project-queries.js";

/**
 * Whether the signed-in person turned on the experimental Feedback Widget.
 * Off while the flags load.
 */
export const useFeedbackWidgetEnabled = () => {
  const identity = useIdentity()?.identity;
  const features = useQuery({
    ...personalExperimentalFeaturesQueryOptions(
      identity?.id as NonNullable<typeof identity>["id"],
    ),
    enabled: identity !== undefined,
  });
  return (
    features.data?.flags.some(
      ({ registration, effectiveEnabled }) =>
        registration.id === FEEDBACK_WIDGET_FEATURE && effectiveEnabled,
    ) === true
  );
};

export const feedbackWidgetKey = (userId: UserId, projectId: ProjectId) =>
  [...projectKeys.detail(userId, projectId), "feedback-widget"] as const;

const path = (projectId: ProjectId, suffix = "") =>
  `/v1/projects/${encodeURIComponent(projectId)}/feedback-widget${suffix}`;

export const feedbackWidgetQueryOptions = (
  userId: UserId,
  projectId: ProjectId,
) =>
  queryOptions({
    queryKey: feedbackWidgetKey(userId, projectId),
    queryFn: async ({ signal }): Promise<FeedbackWidgetData> =>
      (
        await request(path(projectId), GetFeedbackWidgetResponseSchema, {
          signal,
        })
      ).data,
    staleTime: 30_000,
  });

export type FeedbackWidgetChange =
  | { readonly kind: "enable" }
  | { readonly kind: "disable" }
  | { readonly kind: "add-origin"; readonly origin: string }
  | { readonly kind: "remove-origin"; readonly origin: string };

const changeRequest = (projectId: ProjectId, change: FeedbackWidgetChange) => {
  switch (change.kind) {
    case "enable":
      return { url: path(projectId, "/enable"), body: undefined };
    case "disable":
      return { url: path(projectId, "/disable"), body: undefined };
    case "add-origin":
      return {
        url: path(projectId, "/origins"),
        body: { origin: change.origin },
      };
    case "remove-origin":
      return {
        url: path(projectId, "/origins/remove"),
        body: { origin: change.origin },
      };
  }
};

export const changeFeedbackWidgetMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  projectId: ProjectId,
) =>
  mutationOptions({
    mutationKey: [...feedbackWidgetKey(userId, projectId), "change"],
    mutationFn: async (change: FeedbackWidgetChange) => {
      const { url, body } = changeRequest(projectId, change);
      return (
        await request(url, GetFeedbackWidgetResponseSchema, {
          method: "POST",
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        })
      ).data;
    },
    onSuccess: (data) =>
      queryClient.setQueryData(feedbackWidgetKey(userId, projectId), data),
  });

export const personalFeedbackWidgetKey = (userId: UserId) =>
  ["feedback-widget-on-dx", userId] as const;

const personalPath = "/v1/settings/personal/feedback-widget";

/** The widget this dx app loads for the person, and the choices on this dx. */
export const personalFeedbackWidgetQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: personalFeedbackWidgetKey(userId),
    queryFn: async ({ signal }): Promise<PersonalFeedbackWidgetEmbedData> =>
      (
        await request(
          personalPath,
          GetPersonalFeedbackWidgetEmbedResponseSchema,
          { signal },
        )
      ).data,
    staleTime: 5 * 60_000,
  });

/** A script tag or address, or null to stop loading the widget. */
export const updatePersonalFeedbackWidgetMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...personalFeedbackWidgetKey(userId), "update"],
    mutationFn: async (scriptUrl: string | null) =>
      (
        await request(
          personalPath,
          GetPersonalFeedbackWidgetEmbedResponseSchema,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ scriptUrl }),
          },
        )
      ).data,
    onSuccess: (data) =>
      queryClient.setQueryData(personalFeedbackWidgetKey(userId), data),
  });
