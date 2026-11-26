import { defineEndpoint } from "../http/endpoint.js";
import { GetMailboxResponseSchema, MailErrorResponseSchema } from "./mail.js";

/**
 * The mailbox summary endpoint, apart from the other Mail endpoints
 * (mail-endpoints.ts): the sidebar's unread count reads it on every page's
 * first load, and a module that defines endpoints ships whole with whatever
 * imports it (wiki/headless-client.md).
 */

/**
 * A Mail route's refusals: `withMailbox` in apps/core/src/mail/routes.ts
 * refuses with 403 (not the person's own session), 404 (Mail off), and 409
 * (a username still to pick); `statuses` are the route's own.
 */
export const mailRefusals = /*#__NO_SIDE_EFFECTS__*/ (
  ...statuses: ReadonlyArray<400 | 422 | 429>
) =>
  [...statuses, 403, 404, 409].map((status) => ({
    status,
    schema: MailErrorResponseSchema,
  }));

export const GetMailboxEndpoint = defineEndpoint({
  id: "mailbox.get",
  method: "GET",
  path: "/v1/mailbox",
  success: GetMailboxResponseSchema,
  // Mail off answers `{ enabled: false }`; only another session is refused
  // (apps/core/src/mail/routes.ts).
  refusals: [{ status: 403, schema: MailErrorResponseSchema }],
});
