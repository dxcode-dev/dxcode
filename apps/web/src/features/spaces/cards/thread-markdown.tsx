import type * as React from "react";
import { Fragment } from "react";
import { threadIdOfHref } from "../../../shared/ui/thread-reference-context.js";

/**
 * How a Space's chat reads the threads its posts name: lines and lists of
 * links to threads alone become the threads' cards. Loaded with the Space
 * page, never with an ordinary Thread's.
 */

export type CardOf = (threadId: string) => React.ReactNode;

/** A syntax-tree node, as react-markdown hands it to components. */
export interface HastNode {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly children?: ReadonlyArray<HastNode>;
}

const blankText = (node: HastNode) =>
  node.type === "text" && (node.value ?? "").trim() === "";

const threadLinkOf = (node: HastNode | undefined) =>
  node?.type === "element" && node.tagName === "a"
    ? threadIdOfHref(
        typeof node.properties?.href === "string"
          ? node.properties.href
          : undefined,
      )
    : undefined;

/** The Thread a run of nodes links to when it is that link alone. */
const onlyThreadLink = (nodes: ReadonlyArray<HastNode>) => {
  const meaningful = nodes.filter((node) => !blankText(node));
  if (meaningful.length !== 1) return undefined;
  const [only] = meaningful;
  if (only?.type === "element" && only.tagName === "p")
    return onlyThreadLink(only.children ?? []);
  return threadLinkOf(only);
};

const childArray = (
  children: React.ReactNode,
): ReadonlyArray<React.ReactNode> =>
  Array.isArray(children) ? children : [children];

function ThreadCards({
  card,
  threadIds,
}: {
  readonly card: CardOf;
  readonly threadIds: ReadonlyArray<string>;
}) {
  return (
    <div className="markdown-thread-cards">
      {[...new Set(threadIds)].map((threadId) => (
        <Fragment key={threadId}>{card(threadId)}</Fragment>
      ))}
    </div>
  );
}

interface ParagraphBlock {
  readonly kind: "text" | "cards";
  /** The block's first and past-last child of the paragraph. */
  readonly start: number;
  readonly end: number;
  /** For cards: the Threads, one per line. */
  readonly threadIds: ReadonlyArray<string>;
}

/**
 * A paragraph's lines, split at its hard breaks, as runs of text and runs
 * of lines that are each a link to a Thread alone. Undefined when no line
 * is such a link.
 */
const paragraphBlocks = (
  nodes: ReadonlyArray<HastNode>,
): ReadonlyArray<ParagraphBlock> | undefined => {
  const breaks = nodes.flatMap((child, index) =>
    child.type === "element" && child.tagName === "br" ? [index] : [],
  );
  const lines = [...breaks, nodes.length].map((end, index) => {
    const start = index === 0 ? 0 : (breaks[index - 1] ?? 0) + 1;
    return { start, end, thread: onlyThreadLink(nodes.slice(start, end)) };
  });
  if (lines.every(({ thread }) => thread === undefined)) return undefined;
  const blocks: ParagraphBlock[] = [];
  for (const line of lines) {
    const kind = line.thread === undefined ? "text" : "cards";
    if (kind === "text" && nodes.slice(line.start, line.end).every(blankText))
      continue;
    const last = blocks.at(-1);
    const threadIds = line.thread === undefined ? [] : [line.thread];
    if (last?.kind === kind)
      blocks[blocks.length - 1] = {
        kind,
        start: last.start,
        end: line.end,
        threadIds: [...last.threadIds, ...threadIds],
      };
    else blocks.push({ kind, start: line.start, end: line.end, threadIds });
  }
  return blocks;
};

/**
 * A paragraph whose lines are links to Threads alone shows those lines as
 * the Threads' cards; its other lines stay a paragraph.
 */
export function ThreadAwareParagraph({
  node,
  card,
  children,
}: {
  readonly node: HastNode | undefined;
  readonly card: CardOf;
  readonly children: React.ReactNode;
}) {
  const nodes = node?.children ?? [];
  const rendered = childArray(children);
  const blocks =
    rendered.length === nodes.length ? paragraphBlocks(nodes) : undefined;
  if (blocks === undefined) return <p>{children}</p>;
  return (
    <>
      {blocks.map((block) =>
        block.kind === "text" ? (
          <p key={block.start}>{rendered.slice(block.start, block.end)}</p>
        ) : (
          <ThreadCards
            key={block.start}
            card={card}
            threadIds={block.threadIds}
          />
        ),
      )}
    </>
  );
}

/** A list of links to Threads alone shows as the Threads' cards. */
export function ThreadAwareList({
  node,
  card,
  tag: Tag,
  children,
}: {
  readonly node: HastNode | undefined;
  readonly card: CardOf;
  readonly tag: "ul" | "ol";
  readonly children: React.ReactNode;
}) {
  const items = (node?.children ?? []).filter(
    (child) => child.type === "element" && child.tagName === "li",
  );
  const threads = items.map((item) => onlyThreadLink(item.children ?? []));
  return items.length > 0 && threads.every((thread) => thread !== undefined) ? (
    <ThreadCards card={card} threadIds={threads as ReadonlyArray<string>} />
  ) : (
    <Tag>{children}</Tag>
  );
}
