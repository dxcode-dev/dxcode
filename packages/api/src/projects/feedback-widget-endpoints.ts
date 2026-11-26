import { defineEndpoint } from "../http/endpoint.js";
import {
  FeedbackWidgetForbiddenResponseSchema,
  FeedbackWidgetInvalidOriginResponseSchema,
  FeedbackWidgetInvalidRequestResponseSchema,
  FeedbackWidgetInvalidScriptResponseSchema,
  FeedbackWidgetNotFoundResponseSchema,
  FeedbackWidgetOriginRequestSchema,
  FeedbackWidgetParamsSchema,
  FeedbackWidgetTooManyOriginsResponseSchema,
  GetFeedbackWidgetResponseSchema,
  GetPersonalFeedbackWidgetEmbedResponseSchema,
  UpdatePersonalFeedbackWidgetEmbedRequestSchema,
} from "./feedback-widget.js";

export const GetFeedbackWidgetEndpoint = defineEndpoint({
  id: "projects.feedbackWidget.get",
  summary: "Read a Project's feedback widget",
  method: "GET",
  path: "/v1/projects/:projectId/feedback-widget",
  params: FeedbackWidgetParamsSchema,
  success: GetFeedbackWidgetResponseSchema,
  refusals: [
    { status: 400, schema: FeedbackWidgetInvalidRequestResponseSchema },
    { status: 404, schema: FeedbackWidgetNotFoundResponseSchema },
  ],
});

const manageRefusals = [
  { status: 403, schema: FeedbackWidgetForbiddenResponseSchema },
  { status: 400, schema: FeedbackWidgetInvalidRequestResponseSchema },
  { status: 404, schema: FeedbackWidgetNotFoundResponseSchema },
];

export const EnableFeedbackWidgetEndpoint = defineEndpoint({
  id: "projects.feedbackWidget.enable",
  summary: "Turn on a Project's feedback widget",
  method: "POST",
  path: "/v1/projects/:projectId/feedback-widget/enable",
  params: FeedbackWidgetParamsSchema,
  success: GetFeedbackWidgetResponseSchema,
  refusals: manageRefusals,
});

export const DisableFeedbackWidgetEndpoint = defineEndpoint({
  id: "projects.feedbackWidget.disable",
  summary: "Turn off a Project's feedback widget",
  method: "POST",
  path: "/v1/projects/:projectId/feedback-widget/disable",
  params: FeedbackWidgetParamsSchema,
  success: GetFeedbackWidgetResponseSchema,
  refusals: manageRefusals,
});

export const AddFeedbackWidgetOriginEndpoint = defineEndpoint({
  id: "projects.feedbackWidget.addOrigin",
  summary: "Allow a site to embed a Project's feedback widget",
  method: "POST",
  path: "/v1/projects/:projectId/feedback-widget/origins",
  params: FeedbackWidgetParamsSchema,
  body: FeedbackWidgetOriginRequestSchema,
  success: GetFeedbackWidgetResponseSchema,
  refusals: [
    ...manageRefusals,
    { status: 400, schema: FeedbackWidgetInvalidOriginResponseSchema },
    { status: 400, schema: FeedbackWidgetTooManyOriginsResponseSchema },
  ],
});

export const RemoveFeedbackWidgetOriginEndpoint = defineEndpoint({
  id: "projects.feedbackWidget.removeOrigin",
  summary: "Stop a site embedding a Project's feedback widget",
  method: "POST",
  path: "/v1/projects/:projectId/feedback-widget/origins/remove",
  params: FeedbackWidgetParamsSchema,
  body: FeedbackWidgetOriginRequestSchema,
  success: GetFeedbackWidgetResponseSchema,
  refusals: manageRefusals,
});

export const UpdatePersonalFeedbackWidgetEmbedEndpoint = defineEndpoint({
  id: "settings.personal.feedbackWidget.update",
  summary: "Change the person's feedback widget settings",
  method: "PUT",
  path: "/v1/settings/personal/feedback-widget",
  body: UpdatePersonalFeedbackWidgetEmbedRequestSchema,
  success: GetPersonalFeedbackWidgetEmbedResponseSchema,
  refusals: [
    { status: 400, schema: FeedbackWidgetInvalidRequestResponseSchema },
    { status: 400, schema: FeedbackWidgetInvalidScriptResponseSchema },
  ],
});
