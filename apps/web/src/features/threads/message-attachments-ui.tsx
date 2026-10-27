import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import type { MessageAttachment } from "@dx/api";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Paperclip,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as React from "react";
import {
  attachmentPlayable,
  attachmentPreviewKind,
  attachmentTypeLabel,
} from "./attachment-presentation.js";

/**
 * dx's own download route for a message attachment, as a same-origin path.
 * A URL that is not one is not shown.
 */
const attachmentHref = (url: string) => {
  try {
    const { pathname } = new URL(url, window.location.href);
    return pathname.startsWith("/v1/attachments/att_") ? pathname : undefined;
  } catch {
    return undefined;
  }
};

interface ShownAttachment extends MessageAttachment {
  readonly href: string;
}

const shown = (attachments: ReadonlyArray<MessageAttachment>) =>
  attachments.flatMap((attachment): ShownAttachment[] => {
    const href = attachmentHref(attachment.url);
    return href === undefined ? [] : [{ ...attachment, href }];
  });

const isImage = (attachment: MessageAttachment) =>
  attachmentPreviewKind(attachment.mimeType) === "image";

/**
 * A full-window viewer for a message's images: one at a time, stepped with
 * the arrows or the keyboard, never automatically.
 */
function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  readonly images: ReadonlyArray<ShownAttachment>;
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}) {
  const [zoomed, setZoomed] = React.useState(false);
  const image = images[index];
  if (image === undefined) return null;
  const step = (offset: number) => {
    setZoomed(false);
    onIndexChange((index + offset + images.length) % images.length);
  };
  const several = images.length > 1;
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="image-viewer-backdrop" />
        <Dialog.Popup
          className="image-viewer"
          aria-label={image.name}
          onKeyDown={(event) => {
            if (!several) return;
            if (event.key === "ArrowRight") step(1);
            else if (event.key === "ArrowLeft") step(-1);
          }}
        >
          <div className="image-viewer-bar">
            <span className="image-viewer-count">
              {several ? `${index + 1} / ${images.length}` : ""}
            </span>
            <div className="image-viewer-actions">
              <button
                type="button"
                aria-label={zoomed ? "Fit to window" : "Actual size"}
                title={zoomed ? "Fit to window" : "Actual size"}
                onClick={() => setZoomed((value) => !value)}
              >
                {zoomed ? <ZoomOut /> : <ZoomIn />}
              </button>
              <a
                href={`${image.href}?download=1`}
                download={image.name}
                aria-label={`Download ${image.name}`}
                title="Download"
              >
                <Download />
              </a>
              <Dialog.Close aria-label="Close viewer" title="Close">
                <X />
              </Dialog.Close>
            </div>
          </div>
          <div
            className="image-viewer-stage"
            data-zoomed={zoomed ? "" : undefined}
          >
            <img src={image.href} alt={image.name} key={image.id} />
          </div>
          {several ? (
            <>
              <button
                type="button"
                className="image-viewer-step"
                data-direction="previous"
                aria-label="Previous image"
                onClick={() => step(-1)}
              >
                <ChevronLeft />
              </button>
              <button
                type="button"
                className="image-viewer-step"
                data-direction="next"
                aria-label="Next image"
                onClick={() => step(1)}
              >
                <ChevronRight />
              </button>
            </>
          ) : null}
          <span className="image-viewer-name">{image.name}</span>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A sent message's images, as square tiles above its bubble. */
export function MessageImageTiles({
  attachments,
}: {
  readonly attachments: ReadonlyArray<MessageAttachment>;
}) {
  const [open, setOpen] = React.useState<number>();
  const images = shown(attachments).filter(isImage);
  if (images.length === 0) return null;
  return (
    <section className="message-image-tiles" aria-label="Attached images">
      {images.map((image, index) => (
        <button
          type="button"
          className="message-image-tile"
          aria-label={`View ${image.name}`}
          title={image.name}
          key={image.id}
          onClick={() => setOpen(index)}
        >
          <img src={image.href} alt="" loading="lazy" />
        </button>
      ))}
      {open === undefined ? null : (
        <ImageViewer
          images={images}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(undefined)}
        />
      )}
    </section>
  );
}

function FileLink({ attachment }: { readonly attachment: ShownAttachment }) {
  const kind = attachmentPreviewKind(attachment.mimeType);
  const playable = attachmentPlayable(attachment.mimeType);
  const label = (
    <>
      <Paperclip aria-hidden="true" />
      <span>{attachment.name}</span>
    </>
  );
  if (!playable)
    return (
      <a
        className="message-file-link"
        href={`${attachment.href}?download=1`}
        download={attachment.name}
        title={`Download ${attachment.name}`}
      >
        {label}
      </a>
    );
  // Playable media opens a player in the chat instead of leaving it.
  return (
    <Popover.Root>
      <Popover.Trigger className="message-file-link" title={attachment.name}>
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="message-file-player-positioner"
          side="top"
          align="start"
          sideOffset={8}
        >
          <Popover.Popup
            className="message-file-player"
            aria-label={attachment.name}
          >
            {kind === "video" ? (
              // biome-ignore lint/a11y/useMediaCaption: user-supplied media has no captions.
              <video
                src={attachment.href}
                controls
                playsInline
                preload="metadata"
              />
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: user-supplied media has no captions.
              <audio src={attachment.href} controls preload="metadata" />
            )}
            <div className="message-file-player-footer">
              <div className="attachment-preview-meta">
                <span className="attachment-preview-name">
                  {attachment.name}
                </span>
                <span className="attachment-preview-type">
                  {attachmentTypeLabel(attachment.name, attachment.mimeType)}
                </span>
              </div>
              <a
                className="attachment-preview-action"
                href={`${attachment.href}?download=1`}
                download={attachment.name}
                aria-label={`Download ${attachment.name}`}
                title="Download"
              >
                <Download />
              </a>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A sent message's other files, as links at the end of its bubble. */
export function MessageFileLinks({
  attachments,
}: {
  readonly attachments: ReadonlyArray<MessageAttachment>;
}) {
  const files = shown(attachments).filter((attachment) => !isImage(attachment));
  if (files.length === 0) return null;
  return (
    <ul className="message-file-links" aria-label="Attached files">
      {files.map((file) => (
        <li key={file.id}>
          <FileLink attachment={file} />
        </li>
      ))}
    </ul>
  );
}
