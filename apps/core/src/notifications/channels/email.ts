import { type EmailSender, senderAddress } from "../../email/sender.js";
import {
  type ChannelDelivery,
  ChannelDeliveryError,
  type NotificationChannel,
} from "./channel.js";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const initial = (name: string | undefined) =>
  (name?.trim().at(0) ?? "?").toUpperCase();

const capitalized = (value: string) =>
  `${value.at(0)?.toUpperCase() ?? ""}${value.slice(1)}`;

/** A notification email: who did what, the message in a card, one link. */
export const notificationEmail = ({
  content,
  topicNoun,
  links,
}: ChannelDelivery) => {
  const open = escapeHtml(links.open);
  const unsubscribe = escapeHtml(links.unsubscribe);
  const unsubscribeLabel = `Unsubscribe from ${topicNoun} emails`;
  const text = [
    content.headline,
    "",
    content.title,
    content.body,
    "",
    `Open thread: ${links.open}`,
    "",
    `You received this email because ${content.reason}.`,
    `${unsubscribeLabel}: ${links.unsubscribe}`,
  ].join("\n");
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#14171a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr><td style="font-size:26px;font-weight:700;letter-spacing:-0.03em;padding-bottom:28px;">dx</td></tr>
          <tr><td style="font-size:15px;line-height:22px;color:#55595e;padding-bottom:16px;">${escapeHtml(content.headline)}</td></tr>
          <tr><td style="padding-bottom:24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;border:1px solid #e7e5e4;border-radius:8px;">
              <tr>
                <td width="40" valign="top" style="padding:20px 0 20px 20px;">
                  <div style="width:36px;height:36px;border-radius:18px;background:#1f4e8c;color:#ffffff;font-size:16px;font-weight:600;line-height:36px;text-align:center;">${escapeHtml(initial(content.actorName))}</div>
                </td>
                <td valign="top" style="padding:20px 20px 20px 14px;">
                  <div style="font-size:15px;font-weight:600;line-height:22px;padding-bottom:4px;">${escapeHtml(content.title)}</div>
                  <div style="font-size:15px;line-height:22px;color:#14171a;white-space:pre-wrap;word-break:break-word;">${escapeHtml(content.body)}</div>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding-bottom:28px;font-size:15px;">
            <a href="${open}" style="color:#5b3fb1;text-decoration:underline;">Open thread &rarr;</a>
          </td></tr>
          <tr><td style="border-top:1px solid #e7e5e4;padding-top:20px;font-size:13px;line-height:20px;color:#6b7076;">
            You received this email because ${escapeHtml(content.reason)}.<br />
            <a href="${unsubscribe}" style="color:#6b7076;text-decoration:underline;">${escapeHtml(unsubscribeLabel)}</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return { subject: content.subject, text, html };
};

/**
 * Email through the deployment's Cloudflare Email Sending sender. Available
 * whenever a sender is configured, whatever sign-in methods are offered.
 */
export const emailChannel = (
  sender: EmailSender | undefined,
): NotificationChannel => ({
  id: "email",
  subscriptionTitle: (topicNoun) => `${capitalized(topicNoun)} emails`,
  subscriptionDescription: (trigger) => `Receive an email when ${trigger}.`,
  available: sender !== undefined,
  deliver: async (delivery) => {
    if (sender === undefined) throw new ChannelDeliveryError("unavailable");
    try {
      await sender.binding.send({
        from: senderAddress(sender),
        to: delivery.recipient.email,
        ...notificationEmail(delivery),
        headers: {
          "List-Unsubscribe": `<${delivery.links.unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
    } catch (cause) {
      throw new ChannelDeliveryError("email_send_failed", { cause });
    }
  },
});
