import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import {
  CreateMailLabelRequestSchema,
  GetMailConversationResponseSchema,
  ListMailConversationsQuerySchema,
  ListMailConversationsResponseSchema,
  MailAcknowledgedResponseSchema,
  MailAttachmentParamsSchema,
  MailConversationParamsSchema,
  MailLabelParamsSchema,
  MailLabelResponseSchema,
  SendMailRequestSchema,
  SendMailResponseSchema,
  UpdateMailboxSettingsRequestSchema,
  UpdateMailConversationRequestSchema,
  UpdateMailLabelRequestSchema,
} from "./mail.js";
import { mailRefusals } from "./mailbox-endpoint.js";

/**
 * The Mail endpoints, apart from their schemas: a module that defines
 * endpoints ships whole with whatever imports it, so code that reads Mail
 * schemas never loads these (wiki/headless-client.md).
 */

export const ListMailConversationsEndpoint = defineEndpoint({
  id: "mailbox.conversations.list",
  method: "GET",
  path: "/v1/mailbox/conversations",
  query: ListMailConversationsQuerySchema,
  success: ListMailConversationsResponseSchema,
  refusals: mailRefusals(),
});

export const GetMailConversationEndpoint = defineEndpoint({
  id: "mailbox.conversations.get",
  method: "GET",
  path: "/v1/mailbox/conversations/:key",
  params: MailConversationParamsSchema,
  success: GetMailConversationResponseSchema,
  refusals: mailRefusals(),
});

export const UpdateMailConversationEndpoint = defineEndpoint({
  id: "mailbox.conversations.update",
  method: "PATCH",
  path: "/v1/mailbox/conversations/:key",
  params: MailConversationParamsSchema,
  body: UpdateMailConversationRequestSchema,
  success: MailAcknowledgedResponseSchema,
  refusals: mailRefusals(400),
});

export const CreateMailLabelEndpoint = defineEndpoint({
  id: "mailbox.labels.create",
  method: "POST",
  path: "/v1/mailbox/labels",
  body: CreateMailLabelRequestSchema,
  success: MailLabelResponseSchema,
  successStatus: 201,
  refusals: mailRefusals(400),
});

export const UpdateMailLabelEndpoint = defineEndpoint({
  id: "mailbox.labels.update",
  method: "PATCH",
  path: "/v1/mailbox/labels/:id",
  params: MailLabelParamsSchema,
  body: UpdateMailLabelRequestSchema,
  success: MailAcknowledgedResponseSchema,
  refusals: mailRefusals(400),
});

export const DeleteMailLabelEndpoint = defineEndpoint({
  id: "mailbox.labels.delete",
  method: "DELETE",
  path: "/v1/mailbox/labels/:id",
  params: MailLabelParamsSchema,
  success: MailAcknowledgedResponseSchema,
  refusals: mailRefusals(),
});

export const UpdateMailboxSettingsEndpoint = defineEndpoint({
  id: "mailbox.settings.update",
  method: "PATCH",
  path: "/v1/mailbox/settings",
  body: UpdateMailboxSettingsRequestSchema,
  success: MailAcknowledgedResponseSchema,
  refusals: mailRefusals(400),
});

export const SendMailEndpoint = defineEndpoint({
  id: "mailbox.send",
  method: "POST",
  path: "/v1/mailbox/send",
  body: SendMailRequestSchema,
  success: SendMailResponseSchema,
  successStatus: 201,
  refusals: mailRefusals(400, 422, 429),
});

/** An attachment's bytes, always as a download. */
export const GetMailAttachmentEndpoint = defineEndpoint({
  id: "mailbox.attachment",
  method: "GET",
  path: "/v1/mailbox/messages/:id/attachments/:index",
  params: MailAttachmentParamsSchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: mailRefusals(),
});
