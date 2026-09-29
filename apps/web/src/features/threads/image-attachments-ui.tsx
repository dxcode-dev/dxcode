import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Eye, Monitor, Paperclip, X } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { IMAGE_ACCEPT, type PendingImage } from "./image-attachments.js";

export function ImagePreviews({
  images,
  onRemove,
  disabled = false,
}: {
  readonly images: ReadonlyArray<PendingImage>;
  readonly onRemove: (image: PendingImage) => void;
  readonly disabled?: boolean;
}) {
  if (images.length === 0) return null;
  return (
    <section className="composer-attachments" aria-label="Attachments">
      {images.map((image) => (
        <ImagePreview
          image={image}
          onRemove={() => onRemove(image)}
          disabled={disabled}
          key={image.id}
        />
      ))}
    </section>
  );
}

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
  readonly image: Pick<PendingImage, "filename" | "previewUrl">;
  readonly onRemove: () => void;
  readonly disabled: boolean;
}) {
  const label = image.filename ?? "image";
  const [open, setOpen] = React.useState(false);
  return (
    <span className="composer-attachment">
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger
          className="composer-attachment-preview"
          aria-label={`Preview ${label}`}
          title={`Preview ${label}`}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <img src={image.previewUrl} alt="" />
          <Eye aria-hidden="true" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="image-preview-backdrop" />
          <Dialog.Viewport className="image-preview-viewport">
            <Dialog.Popup className="image-preview-dialog" aria-label={label}>
              <Dialog.Close aria-label="Close image preview">
                <X />
              </Dialog.Close>
              <img src={image.previewUrl} alt={label} />
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
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
        aria-label="Choose images"
        accept={IMAGE_ACCEPT}
        multiple
        disabled={disabled}
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <Menu.Root open={open && !disabled} onOpenChange={setOpen}>
        <Menu.Trigger
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
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="attachment-menu-positioner"
            side="top"
            align="start"
            sideOffset={6}
          >
            <Menu.Popup className="attachment-menu">
              <Menu.Item
                nativeButton
                render={<button type="button" />}
                onClick={() => inputRef.current?.click()}
              >
                <Paperclip /> <span>Add Images &amp; Files</span>
                <kbd>⌘U</kbd>
              </Menu.Item>
              <Menu.Item
                nativeButton
                render={<button type="button" />}
                onClick={onScreenshot}
              >
                <Monitor /> <span>Take Screenshot</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}
