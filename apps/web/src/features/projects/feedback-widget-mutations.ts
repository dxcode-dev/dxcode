import { UpdatePersonalFeedbackWidgetEmbedEndpoint } from "@dx/api";
import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { personalFeedbackWidgetKey } from "./feedback-widget-queries.js";

/** A script tag or address, or null to stop loading the widget. */
export const updatePersonalFeedbackWidgetMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...personalFeedbackWidgetKey(userId), "update"],
    mutationFn: async (scriptUrl: string | null) =>
      (
        await dxClient.call(UpdatePersonalFeedbackWidgetEmbedEndpoint, {
          body: { scriptUrl },
        })
      ).data,
    onSuccess: (data) =>
      queryClient.setQueryData(personalFeedbackWidgetKey(userId), data),
  });
