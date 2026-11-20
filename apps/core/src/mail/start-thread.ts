import {
  type CreateThreadRequestSchema,
  parseMessageAttachments,
  withMessageAttachments,
} from "@dx/api";
import {
  escapeEmailContent,
  generateThreadTitle,
  type UserId,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { ownerRequest } from "../threads/owner-request.js";

/**
 * Start thread in Mail (wiki/agent-mail.md): the person opens the New Thread
 * composer on an email, with the email attached, and sends it. Email never
 * starts or continues work by itself; only this action does.
 */

const MAX_EMAIL_CHARS = 50_000;

/**
 * What the agent receives: the person's instruction is the request; the
 * email, its sender, subject, and attachment names are wrapped data.
 */
export const emailRequestBody = (input: {
  readonly senderEmail: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<{ readonly filename: string }>;
  readonly instruction: string;
}) => {
  // Header text sits outside <email_content>, so it is one escaped line.
  const line = (text: string, max: number) =>
    escapeEmailContent(
      text
        .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
        .trim()
        .slice(0, max),
    );
  return [
    `The owner started this Thread from an email in their dx Mail, from ${line(input.senderEmail, 320)}.`,
    `Subject: ${line(input.subject, 300) || "(no subject)"}`,
    "",
    input.instruction.trim() || "(The owner wrote no instruction.)",
    ...(input.attachments.length === 0
      ? []
      : [
          "",
          `Attachments (not included): ${input.attachments
            .slice(0, 20)
            .map(({ filename }) => line(filename, 120))
            .join(", ")}`,
        ]),
    ...(input.text.trim() === ""
      ? []
      : [
          "",
          `<email_content kind="email">\n${escapeEmailContent(input.text.slice(0, MAX_EMAIL_CHARS))}\n</email_content>`,
        ]),
  ].join("\n");
};

/**
 * The New Thread composer's request with the email in its first message:
 * the person's prompt is the request, the email wrapped data, and the
 * email's subject names the Thread. The result is checked as any
 * `POST /v1/threads` request before it is sent.
 */
export const mailThreadRequest = (
  request: { readonly [key: string]: unknown },
  email: Omit<Parameters<typeof emailRequestBody>[0], "instruction">,
) => {
  const message = request.initialMessage as
    | { readonly body?: unknown; readonly attachments?: unknown }
    | undefined;
  // The composer's files trail its prompt as an attachment block, which
  // Core reads only at the end of a message: it goes after the email.
  const prompt = parseMessageAttachments(
    typeof message?.body === "string" ? message.body : "",
  );
  return {
    ...request,
    title: generateThreadTitle(email.subject.trim() || "Email"),
    generateTitle: false,
    initialMessage: {
      attachments: message?.attachments ?? [],
      body: withMessageAttachments(
        emailRequestBody({ ...email, instruction: prompt.text }),
        prompt.attachments,
      ),
    },
  };
};

/**
 * Starts the Thread as `POST /v1/threads` would for the person. Its first
 * message carries `automation="email"`, so the email is untrusted data and
 * `manage_dx` refuses the turn. Answers with `/v1/threads`' own response, so
 * the composer reads it as a new Thread's.
 */
export const startMailThread = (
  bindings: Bindings,
  input: {
    readonly ownerUserId: string;
    readonly request: typeof CreateThreadRequestSchema.Encoded;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
) =>
  ownerRequest(
    {
      bindings,
      ownerUserId: input.ownerUserId as UserId,
      waitUntil: input.waitUntil,
      automation: "email",
    },
    "POST",
    "/v1/threads",
    input.request,
  );
