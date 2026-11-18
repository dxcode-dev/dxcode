import {
  MAILBOX_FEATURE_ID,
  productionExperimentalFeatureRegistry,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";

/** Mail is on for a deployment that sets a valid mail domain. */
export interface MailConfiguration {
  readonly domain: string;
}

const DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The deployment's mail configuration, or undefined when mail is off for
 * everyone. Each person also turns the Mailbox on for themselves with the
 * `mailbox` experimental feature (`mailboxFor`).
 */
export const mailConfiguration = (
  bindings: Pick<Bindings, "DX_MAIL_DOMAIN">,
): MailConfiguration | undefined => {
  const domain = bindings.DX_MAIL_DOMAIN?.trim().toLowerCase();
  return domain !== undefined && DOMAIN.test(domain) ? { domain } : undefined;
};

const mailboxDefault =
  productionExperimentalFeatureRegistry.features.find(
    ({ id }) => id === MAILBOX_FEATURE_ID,
  )?.defaultEnabled ?? false;

/**
 * Whether the person turned the dx Mailbox on: their `mailbox` experimental
 * feature, else its default. Read straight from their stored preferences,
 * since inbound mail and agents act without the person's session.
 */
export const mailboxFeatureOn = async (db: D1Database, userId: string) => {
  const stored = await db
    .prepare(
      "SELECT preferences FROM personal_experimental_feature_preferences WHERE user_id = ?",
    )
    .bind(userId)
    .first<string>("preferences");
  if (stored === null) return mailboxDefault;
  try {
    const found = (
      JSON.parse(stored) as Array<{ id?: unknown; enabled?: unknown }>
    ).find(({ id }) => id === MAILBOX_FEATURE_ID);
    return typeof found?.enabled === "boolean" ? found.enabled : mailboxDefault;
  } catch {
    return false;
  }
};

/**
 * The person's mail configuration: the deployment's, when it sets a mail
 * domain and the person turned the Mailbox on; otherwise undefined, and
 * they have no Mailbox, tools, prompt line, or address.
 */
export const mailboxFor = async (
  bindings: Pick<Bindings, "DX_MAIL_DOMAIN" | "DB">,
  userId: string,
): Promise<MailConfiguration | undefined> => {
  const configuration = mailConfiguration(bindings);
  return configuration === undefined ||
    bindings.DB === undefined ||
    !(await mailboxFeatureOn(bindings.DB, userId))
    ? undefined
    : configuration;
};

/** Where local development's outgoing mail is kept, never sent. */
export const LOCAL_OUTBOX_PREFIX = "dev-outbox/";

/**
 * What sends from the mail domain: the deployment's `MAIL_SEND` binding.
 * Local development has none and makes no external calls, so it keeps each
 * email in R2 under `dev-outbox/` instead (`GET /dev/mail/outbox`).
 */
export const mailSender = (
  bindings: Pick<Bindings, "MAIL_SEND" | "DX_RUNTIME_MODE" | "DX_STORAGE">,
): SendEmail | undefined => {
  if (bindings.MAIL_SEND !== undefined) return bindings.MAIL_SEND;
  const bucket = bindings.DX_STORAGE;
  if (bindings.DX_RUNTIME_MODE !== "local" || bucket === undefined)
    return undefined;
  return {
    send: async (message: unknown) => {
      const messageId = `${crypto.randomUUID()}@local.outbox`;
      const builder = message as Record<string, unknown>;
      await bucket.put(
        `${LOCAL_OUTBOX_PREFIX}${new Date().toISOString()}-${messageId}.json`,
        JSON.stringify({
          messageId,
          sentAt: new Date().toISOString(),
          ...builder,
          // Attachment bytes as sizes only.
          attachments: Array.isArray(builder.attachments)
            ? (builder.attachments as Array<Record<string, unknown>>).map(
                ({ content, ...rest }) => ({
                  ...rest,
                  size:
                    content instanceof Uint8Array
                      ? content.byteLength
                      : String(content ?? "").length,
                }),
              )
            : undefined,
        }),
      );
      return { messageId };
    },
  } as SendEmail;
};
