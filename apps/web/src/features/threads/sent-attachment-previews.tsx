import type { MessageAttachment } from "@dx/api";
import { X } from "lucide-react";
import * as React from "react";
import { attachmentPreviewKind } from "./attachment-presentation.js";
import {
  AttachmentMedia,
  AttachmentPreviewDialog,
} from "./image-attachment-previews.js";

/**
 * The files a sent message carries, while the person edits it: each with
 * its preview and a Remove, as the composer shows files it is about to send.
 */
export function SentAttachmentPreviews({
  attachments,
  onRemove,
  disabled = false,
}: {
  readonly attachments: ReadonlyArray<MessageAttachment>;
  readonly onRemove: (attachment: MessageAttachment) => void;
  readonly disabled?: boolean;
}) {
  if (attachments.length === 0) return null;
  return (
    <section className="composer-attachments" aria-label="Attachments">
      {attachments.map((attachment) => (
        <SentAttachmentThumbnail
          attachment={attachment}
          onRemove={() => onRemove(attachment)}
          disabled={disabled}
          key={attachment.id}
        />
      ))}
    </section>
  );
}

function SentAttachmentThumbnail({
  attachment,
  onRemove,
  disabled,
}: {
  readonly attachment: MessageAttachment;
  readonly onRemove: () => void;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const kind = attachmentPreviewKind(attachment.mimeType);
  return (
    <span className="composer-attachment" title={attachment.name}>
      <button
        type="button"
        className="composer-attachment-preview"
        aria-label={`Preview ${attachment.name}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <AttachmentMedia
          kind={kind}
          url={attachment.url}
          name={attachment.name}
          controls={false}
        />
      </button>
      <button
        type="button"
        className="composer-attachment-remove"
        aria-label={`Remove ${attachment.name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X />
      </button>
      {open ? (
        <AttachmentPreviewDialog
          onClose={() => setOpen(false)}
          name={attachment.name}
          mimeType={attachment.mimeType}
          size={attachment.size}
          url={attachment.url}
          onRemove={onRemove}
          removeDisabled={disabled}
        />
      ) : null}
    </span>
  );
}
