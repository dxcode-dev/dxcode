import type { ThreadId } from "@dx/domain";
import type { Node } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import { Decoration } from "prosemirror-view";

/**
 * Embeds: a line of a document that holds only a link to an artifact shows
 * that artifact below it, read only. A board shows its preview; clicking it
 * opens the board, where it is edited. The Markdown keeps only the link, so
 * export, the agent, and copying all see a plain link.
 */

export interface ArtifactLink {
  readonly threadId: ThreadId;
  readonly artifactId: string;
}

/** The artifact a link points at, on this app's own origin. */
export const artifactLink = (href: string): ArtifactLink | undefined => {
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return undefined;
    const thread = /^\/threads\/(thr_[0-9a-f-]{36})\/?$/.exec(url.pathname);
    const artifactId = url.searchParams.get("artifact");
    if (thread === null || artifactId === null) return undefined;
    if (!/^art_[0-9a-f]{32}$/.test(artifactId)) return undefined;
    return { threadId: thread[1] as ThreadId, artifactId };
  } catch {
    return undefined;
  }
};

/** A link to an artifact, as the agent and Copy Link write it. */
export const artifactHref = (threadId: string, artifactId: string) =>
  `/threads/${threadId}?artifact=${artifactId}&sheet=artifact`;

export interface ArtifactEmbedFrame {
  readonly id: number;
  readonly container: HTMLElement;
  readonly link: ArtifactLink;
}

export interface EmbedHost {
  /** Shows the artifact in `container`; returns how to stop. */
  readonly showEmbed: (
    container: HTMLElement,
    link: ArtifactLink,
  ) => () => void;
}

/** The link a paragraph is made of, alone; undefined for anything else. */
const linkOnly = (paragraph: Node): string | undefined => {
  let href: string | undefined;
  let other = false;
  paragraph.forEach((child) => {
    const mark = child.marks.find(
      (candidate) => candidate.type.name === "link",
    );
    if (mark === undefined) {
      if (child.isText && (child.text ?? "").trim() === "") return;
      other = true;
      return;
    }
    const value = String(mark.attrs.href ?? "");
    if (href !== undefined && href !== value) other = true;
    href = value;
  });
  return other ? undefined : href;
};

const STOP = new WeakMap<HTMLElement, () => void>();

/** A widget below each paragraph that is only a link to an artifact. */
export const embedDecorations = (state: EditorState, host: EmbedHost) => {
  const found: Decoration[] = [];
  const seen = new Map<string, number>();
  state.doc.forEach((node, offset) => {
    if (node.type.name !== "paragraph" || node.childCount === 0) return;
    const href = linkOnly(node);
    const link = href === undefined ? undefined : artifactLink(href);
    if (link === undefined) return;
    // The same link twice embeds twice; each keeps its widget as text moves.
    const count = seen.get(link.artifactId) ?? 0;
    seen.set(link.artifactId, count + 1);
    found.push(
      Decoration.widget(
        offset + node.nodeSize,
        () => {
          const container = document.createElement("div");
          container.className = "artifact-embed";
          container.contentEditable = "false";
          STOP.set(container, host.showEmbed(container, link));
          return container;
        },
        {
          key: `embed:${link.threadId}:${link.artifactId}:${count}`,
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
          destroy: (dom) => {
            if (dom instanceof HTMLElement) STOP.get(dom)?.();
          },
        },
      ),
    );
  });
  return found;
};
