import { createContext, type ReactNode } from "react";

/**
 * People Markdown may tag as `@handle`, and how a tag renders. Provided by the
 * feature that knows who they are; without it, `@handle` stays plain text.
 */
export interface MarkdownMentions {
  /** Handles to highlight, matched case-insensitively. */
  readonly handles: ReadonlyArray<string>;
  readonly render: (handle: string, text: ReactNode) => ReactNode;
}

export const MarkdownMentionContext = createContext<
  MarkdownMentions | undefined
>(undefined);
