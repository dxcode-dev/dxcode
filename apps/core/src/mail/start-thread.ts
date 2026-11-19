import {
  escapeEmailContent,
  THREAD_TITLE_MAX_LENGTH,
  type UserId,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { mailLogger } from "../logging.js";
import { ownerRequest } from "../threads/owner-request.js";

/**
 * Start thread in Mail (wiki/agent-mail.md): the person picks an email, a
 * Project, and writes what to do. Email never starts or continues work by
 * itself; only this action does.
 */

const MAX_INSTRUCTION_CHARS = 20_000;
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
    input.instruction.slice(0, MAX_INSTRUCTION_CHARS) ||
      "(The owner wrote no instruction.)",
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
 * Starts a private Thread owned by the person in the Project, in their own
 * default mode. The first message carries `automation="email"`, so the
 * email is untrusted data and `manage_dx` refuses the turn. Returns the
 * Thread's id, or undefined when it did not start.
 */
export const startMailThread = async (
  bindings: Bindings,
  input: {
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly title: string;
    readonly body: string;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
) => {
  const started = await ownerRequest(
    {
      bindings,
      ownerUserId: input.ownerUserId as UserId,
      waitUntil: input.waitUntil,
      automation: "email",
    },
    "POST",
    "/v1/threads",
    {
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title.slice(0, THREAD_TITLE_MAX_LENGTH).trimEnd(),
      generateTitle: false,
      initialMessage: { body: input.body, attachments: [] },
    },
  );
  const created = (started.payload?.data as { id?: unknown } | undefined)?.id;
  if (!started.response.ok || created !== input.threadId) {
    mailLogger.warn("An email could not start a Thread.", {
      event: "mail_start_failed",
      projectId: input.projectId,
      ownerUserId: input.ownerUserId,
      status: started.response.status,
      code: (started.payload?.data as { code?: string } | undefined)?.code,
    });
    return undefined;
  }
  return input.threadId;
};
