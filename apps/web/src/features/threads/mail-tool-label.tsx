import type { ToolPart } from "@dx/client";
import { useNavigate } from "@tanstack/react-router";
import {
  emailOf,
  mailboxUrlOf,
  mailOutputOf,
  mailText,
} from "./mail-tool-part.js";

/** "Read email: Your code is 482917", "Listed emails". */
export function MailToolLabel({ part }: { readonly part: ToolPart }) {
  const email = emailOf(part);
  const subject = mailText(email?.subject);
  if (part.toolName === "list_emails") {
    const emails = mailOutputOf(part)?.emails;
    return (
      <>
        Listed emails
        {Array.isArray(emails) ? <small>{emails.length}</small> : null}
      </>
    );
  }
  const verb =
    part.toolName === "wait_for_email"
      ? part.state === "output-available"
        ? subject === undefined
          ? "Waited for email"
          : "Received email:"
        : "Waiting for email"
      : "Read email:";
  return (
    <>
      {verb}
      {subject === undefined ? null : (
        <>
          {" "}
          <strong>{subject}</strong>
        </>
      )}
    </>
  );
}

/** "Open in Mail", beside a mail tool's row when its result links one. */
export function MailToolOpener({ part }: { readonly part: ToolPart }) {
  const navigate = useNavigate();
  const url = mailboxUrlOf(part);
  if (url === undefined) return null;
  return (
    <a
      className="transcript-mail-open"
      href={url}
      onClick={(event) => {
        event.stopPropagation();
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        void navigate({ href: url });
      }}
    >
      Open in Mail
    </a>
  );
}
