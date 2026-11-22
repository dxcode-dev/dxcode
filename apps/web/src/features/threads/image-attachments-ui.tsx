import { Monitor, Paperclip } from "lucide-react";
import * as React from "react";
import { ShortcutKeycaps } from "../../shared/commands/shortcut-keycaps.js";
import { useCommandKeycaps } from "../../shared/commands/use-command-keycaps.js";
import { lazyComponent } from "../../shared/stale-chunk.js";
import { Button } from "../../shared/ui/button.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/ui/menu.js";
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

const LazyImagePreviews = lazyComponent(() =>
  import("./image-attachment-previews.js").then((module) => ({
    default: module.ImagePreviews,
  })),
);
const LazyImageAttachmentPreviews = lazyComponent(() =>
  import("./image-attachment-previews.js").then((module) => ({
    default: module.ImageAttachmentPreviews,
  })),
);

/**
 * The composer's files, in a row after the attach button. The thumbnails
 * load with the first file a person attaches (image-attachment-previews.tsx).
 */
export function ImagePreviews(
  props: React.ComponentProps<typeof LazyImagePreviews>,
) {
  if (props.images.length === 0) return null;
  return (
    <React.Suspense fallback={null}>
      <LazyImagePreviews {...props} />
    </React.Suspense>
  );
}

/** Image thumbnails for the prototype composer, loaded with the first image. */
export function ImageAttachmentPreviews(
  props: React.ComponentProps<typeof LazyImageAttachmentPreviews>,
) {
  if (props.images.length === 0) return null;
  return (
    <React.Suspense fallback={null}>
      <LazyImageAttachmentPreviews {...props} />
    </React.Suspense>
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
  const addKeycaps = useCommandKeycaps();
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
            <ShortcutKeycaps
              keycaps={addKeycaps("thread.add-images")}
              emptyLabel=""
            />
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
