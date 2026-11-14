import * as React from "react";
import { threadIdOfHref } from "../../../shared/ui/thread-reference-context.js";

/**
 * How a Space's chat reads the threads its posts name: lines and lists of
 * links to threads alone become the threads' cards. Loaded with the Space
 * page, never with an ordinary Thread's.
 */

/**
 * A thread's card. `link` is its link as the message rendered it, shown
 * instead when the thread has no card here.
 */
export type CardOf = (
  threadId: string,
  link: React.ReactNode,
) => React.ReactNode;

/** A line's link to a Thread, and the line as the message rendered it. */
interface ThreadLine {
  readonly threadId: string;
  readonly link: React.ReactNode;
}

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
  lines,
}: {
  readonly card: CardOf;
  readonly lines: ReadonlyArray<ThreadLine>;
}) {
  const seen = new Set<string>();
  const unique = lines.filter(({ threadId }) =>
    seen.has(threadId) ? false : (seen.add(threadId), true),
  );
  return (
    <div className="markdown-thread-cards">
      {unique.map(({ threadId, link }) => (
        <React.Fragment key={threadId}>{card(threadId, link)}</React.Fragment>
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
  readonly lines: ReadonlyArray<ThreadLine>;
}

/**
 * A paragraph's lines, split at its hard breaks, as runs of text and runs
 * of lines that are each a link to a Thread alone. Undefined when no line
 * is such a link.
 */
const paragraphBlocks = (
  nodes: ReadonlyArray<HastNode>,
  rendered: ReadonlyArray<React.ReactNode>,
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
    const lines =
      line.thread === undefined
        ? []
        : [
            {
              threadId: line.thread,
              link: rendered.slice(line.start, line.end),
            },
          ];
    if (last?.kind === kind)
      blocks[blocks.length - 1] = {
        kind,
        start: last.start,
        end: line.end,
        lines: [...last.lines, ...lines],
      };
    else blocks.push({ kind, start: line.start, end: line.end, lines });
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
    rendered.length === nodes.length
      ? paragraphBlocks(nodes, rendered)
      : undefined;
  if (blocks === undefined) return <p>{children}</p>;
  return (
    <>
      {blocks.map((block) =>
        block.kind === "text" ? (
          <p key={block.start}>{rendered.slice(block.start, block.end)}</p>
        ) : (
          <ThreadCards key={block.start} card={card} lines={block.lines} />
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
  // Each rendered item's content: its link, as the message rendered it.
  const rendered = childArray(children).flatMap((child) =>
    React.isValidElement<{ readonly children?: React.ReactNode }>(child)
      ? [child.props.children]
      : [],
  );
  return items.length > 0 && threads.every((thread) => thread !== undefined) ? (
    <ThreadCards
      card={card}
      lines={threads.map((threadId, index) => ({
        threadId: threadId as string,
        link: rendered.length === items.length ? rendered[index] : undefined,
      }))}
    />
  ) : (
    <Tag>{children}</Tag>
  );
}
