import { Mail } from "lucide-react";
import type { ComposerEmail } from "../../shared/new-thread-surface.js";

/**
 * The email a new Thread starts from, shown in the composer's attachment
 * row beside its files. It goes with the prompt as the Thread's first
 * message, so it has no remove button: closing the composer cancels.
 */
export function EmailAttachment({ email }: { readonly email: ComposerEmail }) {
  const subject = email.subject.trim() || "(no subject)";
  return (
    <span
      className="composer-email-attachment"
      role="note"
      aria-label={`Email: ${subject}, from ${email.from}`}
      title={`${subject}\nFrom ${email.from}`}
    >
      <Mail aria-hidden="true" />
      <span className="composer-email-attachment-subject">{subject}</span>
      <span className="composer-email-attachment-from">{email.from}</span>
    </span>
  );
}
