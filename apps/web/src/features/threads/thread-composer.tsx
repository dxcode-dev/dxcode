import { ArrowUp, Paperclip, Square } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { useDictation } from "./dictation/use-dictation.js";
import { ImageAttachmentPreviews } from "./image-attachments-ui.js";

export interface ThreadComposerAttachment {
  readonly id: string;
  readonly filename?: string;
  readonly previewUrl: string;
}

export function ThreadComposer({
  attachments,
  busy,
  dictationAvailable = false,
  draft,
  onAbort,
  onAttachmentsSelected,
  onDraftChange,
  onRemoveAttachment,
  onSubmit,
}: {
  readonly attachments: ReadonlyArray<ThreadComposerAttachment>;
  readonly busy: boolean;
  readonly dictationAvailable?: boolean;
  readonly draft: string;
  readonly onAbort: () => void | Promise<void>;
  readonly onAttachmentsSelected: (
    files: ReadonlyArray<File>,
  ) => void | Promise<void>;
  readonly onDraftChange: (draft: string) => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onSubmit: (draft: string) => void | Promise<void>;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const dictation = useDictation({
    enabled: dictationAvailable,
    onChange: onDraftChange,
    onSend: (text) => void onSubmit(text),
    textareaRef,
  });
  const focusEditor = () => textareaRef.current?.focus();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (dictation.interceptSubmit()) return;
    if (!draft.trim() && attachments.length === 0) return;
    void Promise.resolve(onSubmit(draft)).then(focusEditor, focusEditor);
  };

  const selectAttachments = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    if (files.length === 0) return;
    void Promise.resolve(onAttachmentsSelected(files)).then(
      focusEditor,
      focusEditor,
    );
  };

  return (
    <form className="agent-composer" onSubmit={submit}>
      <ImageAttachmentPreviews
        images={attachments}
        onRemove={(id) => {
          onRemoveAttachment(id);
          focusEditor();
        }}
      />
      <textarea
        ref={textareaRef}
        aria-label="Message"
        data-command-target="thread-composer"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-actions">
        <input
          ref={imageInputRef}
          className="visually-hidden"
          type="file"
          aria-label="Choose images"
          accept="image/*"
          multiple
          tabIndex={-1}
          onChange={selectAttachments}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="composer-attach"
          aria-label="Add images"
          title="Add images"
          onClick={() => imageInputRef.current?.click()}
        >
          <Paperclip />
        </Button>
        <span className="composer-spacer" />
        {dictation.controls}
        {dictation.hideSubmit ? null : (
          <Button
            type="submit"
            size="icon-sm"
            className="composer-submit"
            aria-label={
              busy ? "Send message during active run" : "Send message"
            }
            title={
              busy
                ? "Apply at the next turn boundary or queue for the next run"
                : "Send message"
            }
            disabled={
              !dictation.active && !draft.trim() && attachments.length === 0
            }
          >
            <ArrowUp />
          </Button>
        )}
        {busy ? (
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            className="composer-submit"
            aria-label="Stop agent"
            onClick={() => void onAbort()}
          >
            <Square />
          </Button>
        ) : null}
      </div>
    </form>
  );
}
