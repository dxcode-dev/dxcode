import type * as React from "react";

/**
 * Dictation for surfaces outside the composer, such as an artifact's editor
 * and comment box. The Thread page passes it down only when the deployment
 * serves a speech provider and the person's dictation switch is on; each
 * component renders the composer's mic. A surface with no slot shows no mic.
 *
 * `noticeHost` is where the surface wants the mic's words (listening,
 * transcribing, a failure) shown, such as a line under a toolbar; without
 * one they follow the mic.
 */
export interface DictationSlot {
  /** Puts the transcript wherever `insertText` says, such as an editor. */
  readonly Insert: React.ComponentType<{
    readonly insertText: (text: string) => boolean;
    readonly noticeHost?: HTMLElement | null;
  }>;
  /** Puts the transcript at a textarea's cursor, as the composer does. */
  readonly Textarea: React.ComponentType<{
    readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    readonly onChange: (value: string) => void;
    readonly noticeHost?: HTMLElement | null;
  }>;
}
