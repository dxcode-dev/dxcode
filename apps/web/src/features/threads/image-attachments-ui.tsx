import {
  AlertCircle,
  Eye,
  FileIcon,
  FileVideo,
  Monitor,
  Paperclip,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { LazyImageViewer as ImageViewer } from "../../shared/ui/lazy-image-viewer.js";
import {
  MenuItem,
  MenuItemHint,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/ui/menu.js";
import {
  attachmentPreviewKind,
  attachmentTypeLabel,
  formatAttachmentSize,
  type PreviewKind,
} from "./attachment-presentation.js";
import type { AttachmentUploadState } from "./attachment-upload.js";
import type { PendingAttachment } from "./image-attachments.js";

const noUploads = () => () => {};
const idle = () => false;

/** Whether any of the files is still uploading; re-renders on progress. */
export function useAttachmentsUploading(
  attachments: ReadonlyArray<PendingAttachment>,
) {
  const subscribe =
    attachments.length === 0
      ? noUploads
      : (listener: () => void) => {
          const unsubscribe = attachments.map(({ upload }) =>
            upload.subscribe(listener),
          );
          return () => {
            for (const stop of unsubscribe) stop();
          };
        };
  const snapshot =
    attachments.length === 0
      ? idle
      : () =>
          attachments.some(
            ({ upload }) => upload.getSnapshot().status === "uploading",
          );
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

function useUploadState(attachment: PendingAttachment): AttachmentUploadState {
  return React.useSyncExternalStore(
    attachment.upload.subscribe,
    attachment.upload.getSnapshot,
    attachment.upload.getSnapshot,
  );
}

function ProgressRing({ fraction }: { readonly fraction: number }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      className="attachment-progress-ring"
      viewBox="0 0 36 36"
      role="progressbar"
      aria-label="Uploading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
    >
      <circle cx="18" cy="18" r={radius} className="track" />
      <circle
        cx="18"
        cy="18"
        r={radius}
        className="value"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, fraction))}
      />
    </svg>
  );
}

function AttachmentMedia({
  kind,
  url,
  name,
  controls,
}: {
  readonly kind: PreviewKind;
  readonly url: string;
  readonly name: string;
  readonly controls: boolean;
}) {
  if (kind === "image") return <img src={url} alt={controls ? name : ""} />;
  if (kind === "video")
    return controls ? (
      // biome-ignore lint/a11y/useMediaCaption: user-supplied media has no captions.
      <video src={url} controls playsInline preload="metadata" />
    ) : (
      <span className="attachment-file-thumb">
        <FileVideo aria-hidden="true" />
      </span>
    );
  return (
    <span className="attachment-file-thumb">
      <FileIcon aria-hidden="true" />
    </span>
  );
}

/**
 * A file's preview in the shared viewer: the media (or a file icon), its
 * name, type, and size, and Download and Remove.
 */
function AttachmentPreviewDialog({
  name,
  mimeType,
  size,
  url,
  downloadUrl = url,
  onClose,
  onRemove,
  removeDisabled = false,
}: {
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly url: string;
  readonly downloadUrl?: string;
  readonly onClose: () => void;
  readonly onRemove?: () => void;
  readonly removeDisabled?: boolean;
}) {
  const type = attachmentTypeLabel(name, mimeType);
  return (
    <ImageViewer
      items={[
        {
          key: url,
          url,
          name,
          kind: attachmentPreviewKind(mimeType),
          downloadUrl,
          detail:
            size === undefined
              ? type
              : `${type} · ${formatAttachmentSize(size)}`,
        },
      ]}
      onClose={onClose}
      closeLabel="Close preview"
      showOpenInTab={false}
      actions={() =>
        onRemove === undefined ? null : (
          <Button
            variant="subtle"
            size="icon-sm"
            aria-label={`Remove ${name}`}
            title="Remove"
            disabled={removeDisabled}
            onClick={() => {
              onClose();
              onRemove();
            }}
          >
            <Trash2 />
          </Button>
        )
      }
    />
  );
}

function PendingAttachmentThumbnail({
  attachment,
  onRemove,
  disabled,
}: {
  readonly attachment: PendingAttachment;
  readonly onRemove: () => void;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const state = useUploadState(attachment);
  const kind = attachmentPreviewKind(attachment.mimeType);
  const label = attachment.filename;
  return (
    <span
      className="composer-attachment"
      data-upload={state.status}
      title={state.status === "failed" ? state.error : label}
    >
      <button
        type="button"
        className="composer-attachment-preview"
        aria-label={`Preview ${label}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <AttachmentMedia
          kind={kind}
          url={attachment.previewUrl}
          name={label}
          controls={false}
        />
        {state.status === "uploading" ? (
          <ProgressRing fraction={state.loaded / attachment.size} />
        ) : state.status === "failed" ? (
          <AlertCircle
            className="attachment-upload-failed"
            aria-label="Upload failed"
          />
        ) : null}
      </button>
      {open ? (
        <AttachmentPreviewDialog
          onClose={() => setOpen(false)}
          name={label}
          mimeType={attachment.mimeType}
          size={attachment.size}
          url={attachment.previewUrl}
          onRemove={onRemove}
          removeDisabled={disabled}
        />
      ) : null}
    </span>
  );
}

/** The composer's files, in a row after the attach button. */
export function ImagePreviews({
  images,
  onRemove,
  disabled = false,
}: {
  readonly images: ReadonlyArray<PendingAttachment>;
  readonly onRemove: (image: PendingAttachment) => void;
  readonly disabled?: boolean;
}) {
  if (images.length === 0) return null;
  return (
    <section className="composer-attachments" aria-label="Attachments">
      {images.map((image) => (
        <PendingAttachmentThumbnail
          attachment={image}
          onRemove={() => onRemove(image)}
          disabled={disabled}
          key={image.id}
        />
      ))}
    </section>
  );
}

/** Image thumbnails for the prototype composer. */
export function ImageAttachmentPreviews({
  images,
  onRemove,
  disabled = false,
}: {
  readonly images: ReadonlyArray<{
    readonly id: string;
    readonly filename?: string;
    readonly previewUrl: string;
  }>;
  readonly onRemove: (id: string) => void;
  readonly disabled?: boolean;
}) {
  if (images.length === 0) return null;
  return (
    <section className="composer-attachments" aria-label="Attachments">
      {images.map((image) => (
        <ImagePreview
          image={image}
          onRemove={() => onRemove(image.id)}
          disabled={disabled}
          key={image.id}
        />
      ))}
    </section>
  );
}

function ImagePreview({
  image,
  onRemove,
  disabled,
}: {
  readonly image: { readonly filename?: string; readonly previewUrl: string };
  readonly onRemove: () => void;
  readonly disabled: boolean;
}) {
  const label = image.filename ?? "image";
  const [open, setOpen] = React.useState(false);
  return (
    <span className="composer-attachment">
      <button
        type="button"
        className="composer-attachment-preview"
        aria-label={`Preview ${label}`}
        title={`Preview ${label}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <img src={image.previewUrl} alt="" />
        <Eye aria-hidden="true" />
      </button>
      {open ? (
        <ImageViewer
          items={[
            {
              key: image.previewUrl,
              url: image.previewUrl,
              name: label,
              kind: "image",
            },
          ]}
          onClose={() => setOpen(false)}
          closeLabel="Close image preview"
          showOpenInTab={false}
        />
      ) : null}
      <button
        type="button"
        className="composer-attachment-remove"
        aria-label={`Remove ${label}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X />
      </button>
    </span>
  );
}

export function AttachmentMenu({
  disabled,
  onFiles,
  onScreenshot,
}: {
  readonly disabled?: boolean;
  readonly onFiles: (files: ReadonlyArray<File>) => void;
  readonly onScreenshot: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <span className="attachment-menu-wrap">
      <input
        ref={inputRef}
        data-command-action="add-images"
        className="visually-hidden"
        type="file"
        aria-label="Choose files"
        multiple
        disabled={disabled}
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <MenuRoot open={open && !disabled} onOpenChange={setOpen}>
        <MenuTrigger
          nativeButton
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="attachment-trigger"
              aria-label="Add Images & Files"
              disabled={disabled}
            />
          }
        >
          <Paperclip />
        </MenuTrigger>
        <MenuPopup side="top" align="start" sideOffset={6}>
          <MenuItem
            nativeButton
            render={<button type="button" />}
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip />
            <span>Add Images &amp; Files</span>
            <MenuItemHint>⌘U</MenuItemHint>
          </MenuItem>
          <MenuItem
            nativeButton
            render={<button type="button" />}
            onClick={onScreenshot}
          >
            <Monitor />
            <span>Take Screenshot</span>
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
    </span>
  );
}
