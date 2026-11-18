import type { Bindings } from "../http/types.js";
import { mailLogger } from "../logging.js";
import { handleInboundMail, readRawMail } from "./inbound.js";

/**
 * The core Worker's `email` handler: Cloudflare Email Routing's catch-all
 * on the mail domain delivers every message here (wiki/agent-mail.md).
 * `cloudflare:email` loads only when a message arrives, so tests and local
 * HTTP requests never import it.
 */
export const email: EmailExportedHandler<Bindings> = async (
  message,
  bindings,
  context,
) => {
  const raw = await readRawMail(message.raw);
  if (raw === undefined) {
    mailLogger.info("Mail was dropped.", {
      event: "mail_dropped",
      reason: "too_large",
    });
    return;
  }
  try {
    await handleInboundMail(
      bindings,
      {
        from: message.from,
        to: message.to,
        raw,
        reply: async (reply) => {
          const { EmailMessage } = await import("cloudflare:email");
          await message.reply(
            new EmailMessage(reply.from, reply.to, reply.raw),
          );
        },
        setReject: (reason) => message.setReject(reason),
      },
      (promise) => context.waitUntil(promise),
    );
  } catch (cause) {
    // Never bounce: a failure is logged, and the message is dropped.
    mailLogger.error("Inbound mail failed.", {
      event: "mail_inbound_failed",
      cause,
    });
  }
};
