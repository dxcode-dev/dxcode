import type { AttachmentData, MessageAttachment } from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import type { ComposerSlotProps } from "../../shared/composer/composer-slot.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { Button } from "../../shared/ui/button.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import { useComposerEnterKey } from "./composer-enter-key.js";
import { useDictation } from "./dictation/use-dictation.js";
import {
  addScreenshot,
  createPendingAttachmentCollection,
  disposeAttachments,
  type PendingAttachment,
  pastedFiles,
} from "./image-attachments.js";
import {
  AttachmentMenu,
  ImagePreviews,
  useAttachmentsUploading,
} from "./image-attachments-ui.js";
import { useImageDropTarget } from "./image-drop-target.js";

const asMessageAttachment = ({
  id,
  filename,
  mimeType,
  size,
  url,
}: AttachmentData): MessageAttachment => ({
  id,
  name: filename,
  mimeType,
  size,
  url,
});

/**
 * The Thread composer's box for a surface outside the Thread page (see
 * `ComposerSlotProps`): the attach menu, previews, paste and drop, the mic,
 * and Send, laid out and styled as the Thread composer is.
 */
export function SlotComposer({
  label,
  sendLabel,
  draft,
  onDraftChange,
  onSend,
  textareaRef,
  onTextInput,
  onKeyDown,
  above,
  className,
}: ComposerSlotProps) {
  const { identity } = useAuthenticatedIdentity();
  const settings = useQuery(settingsContextQueryOptions(identity.id));
  const [collection] = React.useState(createPendingAttachmentCollection);
  useMountEffect(() => () => collection.dispose());
  const [images, setImages] = React.useState<ReadonlyArray<PendingAttachment>>(
    [],
  );
  const [failure, setFailure] = React.useState<string>();
  // While the files upload, the text and files wait in the box, read-only.
  const [holding, setHolding] = React.useState(false);
  const uploading = useAttachmentsUploading(images);
  const enterKey = useComposerEnterKey();
  const addFiles = (files: ReadonlyArray<File>) => {
    setFailure(undefined);
    collection
      .addFiles(files)
      .then(setImages, (cause: unknown) =>
        setFailure(
          cause instanceof Error ? cause.message : "Try another file.",
        ),
      );
  };
  const send = (text: string) => {
    const files = collection.list();
    if (holding || (text.trim() === "" && files.length === 0)) return;
    setFailure(undefined);
    if (files.length === 0) {
      onDraftChange("");
      void onSend(text, []);
      return;
    }
    setHolding(true);
    void collection
      .settle()
      .then(() =>
        Promise.all(collection.list().map(({ upload }) => upload.settled)),
      )
      .then(
        async (uploaded) => {
          const sent = collection.take();
          setImages([]);
          setHolding(false);
          onDraftChange("");
          if (await onSend(text, uploaded.map(asMessageAttachment)))
            disposeAttachments(sent);
          else setImages(collection.restore([...sent, ...collection.list()]));
        },
        (cause: unknown) => {
          // A file that did not upload stays, so the person can remove it.
          setHolding(false);
          setFailure(
            cause instanceof Error ? cause.message : "A file did not upload.",
          );
        },
      );
  };
  const dictation = useDictation({
    enabled: settings.data?.dictationAvailable === true,
    locked: holding,
    onChange: onDraftChange,
    onSend: send,
    textareaRef,
  });
  const dropTarget = useImageDropTarget({
    disabled: holding,
    onFiles: addFiles,
  });
  const composing =
    dictation.active || draft.trim() !== "" || images.length > 0;
  return (
    <div className={`agent-composer-dock ${className ?? ""}`}>
      {failure === undefined ? null : (
        <p className="composer-slot-error" role="alert">
          {failure}
        </p>
      )}
      {above}
      <form
        className="agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (dictation.interceptSubmit()) return;
          send(draft);
        }}
        {...dropTarget}
      >
        <textarea
          ref={textareaRef}
          aria-label={label}
          enterKeyHint={enterKey.enterKeyHint}
          aria-busy={holding || undefined}
          readOnly={holding}
          value={draft}
          onChange={(event) => {
            onDraftChange(event.target.value);
            onTextInput?.(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
          }}
          onPaste={(event) => {
            const files = pastedFiles(event);
            if (files.length === 0 || holding) return;
            event.preventDefault();
            addFiles(files);
          }}
          onKeyDown={(event) => {
            if (onKeyDown?.(event) === true) return;
            if (enterKey.sends(event)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-actions">
          <AttachmentMenu
            disabled={holding}
            onFiles={addFiles}
            onScreenshot={() =>
              void addScreenshot(collection).then(setImages, () => undefined)
            }
          />
          <ImagePreviews
            images={images}
            disabled={holding}
            onRemove={(image) => setImages(collection.remove(image.id))}
          />
          <span className="composer-spacer" />
          {dictation.controls}
          {dictation.hideSubmit ? null : (
            <Button
              type="submit"
              size="icon-sm"
              className="composer-submit"
              aria-label={sendLabel}
              aria-busy={holding || undefined}
              data-submitting={holding ? "" : undefined}
              disabled={holding || uploading || !composing}
            >
              {holding ? (
                <span
                  className="processing-dot dictation-processing-dot"
                  aria-hidden="true"
                />
              ) : (
                <ArrowUp />
              )}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
