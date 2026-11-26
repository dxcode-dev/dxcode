import { defineEndpoint } from "../http/endpoint.js";
import { GetPersonalFeedbackWidgetEmbedResponseSchema } from "./feedback-widget.js";

export const GetPersonalFeedbackWidgetEmbedEndpoint = defineEndpoint({
  id: "settings.personal.feedbackWidget.get",
  summary: "Read the person's feedback widget settings",
  method: "GET",
  path: "/v1/settings/personal/feedback-widget",
  success: GetPersonalFeedbackWidgetEmbedResponseSchema,
});
