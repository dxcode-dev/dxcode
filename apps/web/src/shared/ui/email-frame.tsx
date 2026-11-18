import { cn } from "../utils.js";
import { emailFrameDocument } from "./email-frame-document.js";
import "./email-frame.css";

/**
 * An email's HTML, shown safely: in a frame with an empty sandbox (no
 * scripts, forms, popups, or same-origin access) whose document loads
 * nothing from the network and cannot navigate itself. It draws on the
 * printed-page color, as a mail client shows HTML mail.
 */
export function EmailFrame({
  html,
  title = "Email as HTML",
  className,
}: {
  /** The email's HTML part, untrusted. */
  readonly html: string;
  /** The frame's accessible name. */
  readonly title?: string;
  readonly className?: string;
}) {
  return (
    <iframe
      className={cn("dx-email-frame", className)}
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={emailFrameDocument(html)}
    />
  );
}
