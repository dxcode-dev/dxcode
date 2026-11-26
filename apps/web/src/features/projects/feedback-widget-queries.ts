import {
  GetPersonalFeedbackWidgetEmbedEndpoint,
  type PersonalFeedbackWidgetEmbedData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";

export const personalFeedbackWidgetKey = (userId: UserId) =>
  ["feedback-widget-on-dx", userId] as const;

/** The widget this dx app loads for the person, and the choices on this dx. */
export const personalFeedbackWidgetQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: personalFeedbackWidgetKey(userId),
    queryFn: async ({ signal }): Promise<PersonalFeedbackWidgetEmbedData> =>
      (
        await dxClient.call(
          GetPersonalFeedbackWidgetEmbedEndpoint,
          {},
          { signal },
        )
      ).data,
    staleTime: 5 * 60_000,
  });
