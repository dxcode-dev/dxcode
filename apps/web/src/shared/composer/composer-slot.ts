import type { MessageAttachment } from "@dx/api";
import type * as React from "react";

/**
 * The Thread composer's box for a surface outside the Thread page, such as a
 * Space's chat: the same attach menu, file previews, paste and drop, mic,
 * Enter key, and Send. The Thread route hands it over, so a feature that
 * writes posts never reaches into the Thread page's code.
 *
 * The surface owns the text. The box owns the files and the mic: Stop puts
 * what was said at the caret, and Send while recording sends what was said
 * directly. A send holds the text and files, read-only, until every file has
 * uploaded, then hands them to `onSend`.
 */
export interface ComposerSlotProps {
  /** The textarea's accessible name, such as "Post to Space". */
  readonly label: string;
  /** The Send button's accessible name, such as "Send Post". */
  readonly sendLabel: string;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  /**
   * Sends the text with its uploaded files. Resolves false when it failed,
   * which puts the files back in the box; the surface puts the text back.
   */
  readonly onSend: (
    text: string,
    attachments: ReadonlyArray<MessageAttachment>,
  ) => Promise<boolean>;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** After each change to the text, with the caret, as a mention menu reads it. */
  readonly onTextInput?: (value: string, caret: number) => void;
  /** Gets each key first; true when it handled the key, as a menu does. */
  readonly onKeyDown?: (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => boolean;
  /** Shown above the box, such as a failure or a mention menu. */
  readonly above?: React.ReactNode;
  readonly className?: string;
}

export type ComposerSlot = React.ComponentType<ComposerSlotProps>;

/**
 * A sent message's files as the Thread transcript shows them: images as
 * tiles above the bubble, other files as links at its end. The Thread route
 * hands these over with its Thread page, so a surface that shows posts uses
 * the transcript's own components without importing them (which would split
 * them out of the Thread page's first load).
 */
export interface MessageFilesSlot {
  readonly Images: React.ComponentType<{
    readonly attachments: ReadonlyArray<MessageAttachment>;
  }>;
  readonly Links: React.ComponentType<{
    readonly attachments: ReadonlyArray<MessageAttachment>;
  }>;
}
