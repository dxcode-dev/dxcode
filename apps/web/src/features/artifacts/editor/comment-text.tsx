import type * as React from "react";
import type { CommentPeople } from "./artifact-comments.js";

/**
 * A mention as artifacts write it, `@[Name](user:ID)`, `@[dx](agent)`, or
 * `@[here](here)`, or an http(s) URL, up to whitespace or brackets.
 */
const PART_PATTERN =
  /@\[([^\]\n]+)\]\((?:user:([A-Za-z0-9_-]+)|agent|(here))\)|https?:\/\/[^\s<>()[\]{}"']+/g;
/** Punctuation that ends a sentence, not the URL before it. */
const TRAILING = /[.,;:!?]+$/;

/**
 * A comment's text as people read it: each http(s) URL a link that opens in
 * a new tab, and each mention a chip. A person's chip shows the name of the
 * member it notifies, never the name written in the text, so a mention
 * cannot pass for someone else; one outside the Thread stays plain text.
 */
export function CommentText({
  text,
  people,
}: {
  readonly text: string;
  /** The Thread's people by user ID, whose names chips show. */
  readonly people: CommentPeople;
}) {
  // Each part keyed by where it starts in the text.
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PART_PATTERN)) {
    const start = match.index;
    const written = match[1];
    const userId = match[2];
    const matched =
      written === undefined ? match[0].replace(TRAILING, "") : match[0];
    if (start > last)
      parts.push(<span key={last}>{text.slice(last, start)}</span>);
    const person = userId === undefined ? undefined : people.get(userId);
    parts.push(
      written === undefined ? (
        <a key={start} href={matched} target="_blank" rel="noopener noreferrer">
          {matched}
        </a>
      ) : match[3] !== undefined ? (
        <span key={start} className="artifact-comment-mention">
          @here
        </span>
      ) : userId === undefined ? (
        <span key={start} className="artifact-comment-mention">
          @dx
        </span>
      ) : person === undefined ? (
        <span key={start}>@{written}</span>
      ) : (
        <span key={start} className="artifact-comment-mention">
          @{person.name}
        </span>
      ),
    );
    last = start + matched.length;
  }
  if (last < text.length)
    parts.push(<span key={last}>{text.slice(last)}</span>);
  return <>{parts}</>;
}
