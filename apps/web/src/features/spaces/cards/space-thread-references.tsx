import type * as React from "react";
import type { Components } from "react-markdown";
import type { ThreadReferences } from "../../../shared/ui/thread-reference-context.js";
import { SpaceThreadCard, SpaceThreadChip } from "./space-thread-card.js";
import {
  type CardOf,
  type HastNode,
  ThreadAwareList,
  ThreadAwareParagraph,
} from "./thread-markdown.js";

const card = (threadId: string, link?: React.ReactNode) => (
  <SpaceThreadCard threadId={threadId} fallback={link} />
);

/** The Markdown elements that show links to threads alone as cards. */
const threadMarkdownComponents = (cardOf: CardOf): Components => ({
  p: ({ node, children }) => (
    <ThreadAwareParagraph node={node as HastNode | undefined} card={cardOf}>
      {children}
    </ThreadAwareParagraph>
  ),
  ul: ({ node, children }) => (
    <ThreadAwareList node={node as HastNode | undefined} card={cardOf} tag="ul">
      {children}
    </ThreadAwareList>
  ),
  ol: ({ node, children }) => (
    <ThreadAwareList node={node as HastNode | undefined} card={cardOf} tag="ol">
      {children}
    </ThreadAwareList>
  ),
});

/**
 * How a Space's transcript shows the threads it names: a thread alone is
 * its live card, one named in a sentence its chip, and a thread's report
 * one row led by its chip.
 */
export const spaceThreadReferences: ThreadReferences = {
  card,
  chip: (threadId, label) => (
    <SpaceThreadChip threadId={threadId} label={label} />
  ),
  markdownComponents: threadMarkdownComponents(card),
};
