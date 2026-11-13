import type { MessageAttachment } from "@dx/api";
import { Download, Paperclip } from "lucide-react";
import * as React from "react";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { LazyImageViewer as ImageViewer } from "../../shared/ui/lazy-image-viewer.js";
import {
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from "../../shared/ui/popover.js";
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

/** One image a tile shows, by a same-origin URL. */
export interface TileImage {
  readonly key: string;
  readonly url: string;
  readonly name: string;
  readonly downloadUrl?: string;
}

/**
 * Images as small square tiles; clicking one opens it in the full-window
 * viewer, stepping through the rest.
 */
export function ImageTiles({
  images,
  label,
  className,
}: {
  readonly images: ReadonlyArray<TileImage>;
  readonly label: string;
  readonly className?: string;
}) {
  const [open, setOpen] = React.useState<number>();
  if (images.length === 0) return null;
  return (
    <section
      className={
        className === undefined
          ? "message-image-tiles"
          : `message-image-tiles ${className}`
      }
      aria-label={label}
    >
      {images.map((image, index) => (
        <button
          type="button"
          className="message-image-tile"
          aria-label={`View ${image.name}`}
          title={image.name}
          key={image.key}
          onClick={() => setOpen(index)}
        >
          <img src={image.url} alt="" loading="lazy" />
        </button>
      ))}
      {open === undefined ? null : (
        <ImageViewer
          items={images.map((image) => ({
            key: image.key,
            url: image.url,
            name: image.name,
            kind: "image",
            ...(image.downloadUrl === undefined
              ? {}
              : { downloadUrl: image.downloadUrl }),
          }))}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(undefined)}
        />
      )}
    </section>
  );
}

/** A sent message's images, as square tiles above its bubble. */
export function MessageImageTiles({
  attachments,
}: {
  readonly attachments: ReadonlyArray<MessageAttachment>;
}) {
  const images = shown(attachments).flatMap((image) =>
    isImage(image)
      ? [
          {
            key: image.id,
            url: image.href,
            name: image.name,
            downloadUrl: `${image.href}?download=1`,
          },
        ]
      : [],
  );
  return <ImageTiles images={images} label="Attached images" />;
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
    <PopoverRoot>
      <PopoverTrigger className="message-file-link" title={attachment.name}>
        {label}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
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
            <span className="attachment-preview-name">{attachment.name}</span>
            <span className="attachment-preview-type">
              {attachmentTypeLabel(attachment.name, attachment.mimeType)}
            </span>
          </div>
          <a
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
            href={`${attachment.href}?download=1`}
            download={attachment.name}
            aria-label={`Download ${attachment.name}`}
            title="Download"
          >
            <Download />
          </a>
        </div>
      </PopoverContent>
    </PopoverRoot>
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
