import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { RichMarkdown } from "../../../shared/ui/rich-markdown.js";
import { ThreadReferenceContext } from "../../../shared/ui/thread-reference-context.js";
import {
  spaceCatchUpQueryOptions,
  useDismissCatchUp,
} from "./space-card-queries.js";
import { spaceThreadReferences } from "./space-thread-references.js";
import "./space-cards.css";

/** The element that scrolls `node`: the chat around the card. */
const scrollerOf = (node: HTMLElement) => {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    )
      return parent;
  }
  return undefined;
};

/**
 * Scrolls the chat once, when the card appears, so all of it shows above
 * the composer: it arrives after the chat opened at its end, below it.
 */
const revealOnce = (node: HTMLElement | null) => {
  if (node === null) return;
  const frame = requestAnimationFrame(() => {
    const scroller = scrollerOf(node);
    if (scroller === undefined) return;
    const below =
      node.getBoundingClientRect().bottom +
      (Number.parseFloat(getComputedStyle(node).scrollMarginBottom) || 0) -
      scroller.getBoundingClientRect().bottom;
    if (below > 0) scroller.scrollBy({ top: below });
  });
  return () => cancelAnimationFrame(frame);
};

/**
 * "Since you've been gone": what the Space's threads did while the person
 * was away, at the end of the chat and visible only to them, until they
 * dismiss it. Its links to the Space's threads read as chips.
 */
export function SpaceCatchUpCard({
  spaceThreadId,
}: {
  readonly spaceThreadId: ThreadId;
}) {
  const { identity } = useAuthenticatedIdentity();
  const catchUp = useQuery(
    spaceCatchUpQueryOptions(identity.id, spaceThreadId),
  ).data;
  const dismiss = useDismissCatchUp(identity.id, spaceThreadId);
  if (catchUp === undefined || catchUp === null) return null;
  return (
    <section
      ref={revealOnce}
      className="space-catch-up"
      aria-labelledby="space-catch-up-title"
    >
      <header className="space-catch-up-header">
        <h3 id="space-catch-up-title">Since you've been gone</h3>
        <small>Visible only to you</small>
        <Button
          variant="subtle"
          size="icon-xs"
          className="space-catch-up-dismiss"
          aria-label="Dismiss"
          onClick={() => dismiss.mutate()}
        >
          <X aria-hidden />
        </Button>
      </header>
      <div className="space-catch-up-body">
        <ThreadReferenceContext.Provider value={spaceThreadReferences}>
          <RichMarkdown>{catchUp.body}</RichMarkdown>
        </ThreadReferenceContext.Provider>
      </div>
    </section>
  );
}
