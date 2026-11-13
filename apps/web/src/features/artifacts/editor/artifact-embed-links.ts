import type { ThreadId } from "@dx/domain";
import type { Node } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import { Decoration } from "prosemirror-view";

/**
 * Embeds: a line of a document that holds only a link to another artifact
 * shows that artifact below it, read only, Notion style. A board shows its
 * drawing and a document its opening lines; clicking either opens it. A
 * link to the artifact itself stays a plain link. The Markdown keeps only
 * the link, so export, the agent, and copying all see a plain link.
 */

export interface ArtifactLink {
  /** Known for a Thread link; an `/artifacts/<id>` link finds it first. */
  readonly threadId?: ThreadId;
  readonly artifactId: string;
}

const ARTIFACT_ID = /^art_[0-9a-f]{32}$/;

/**
 * The artifact a link points at, on this app's own origin: every
 * artifact's link `/artifacts/<id>`, or the older Thread link
 * `/threads/<thread>?artifact=<id>`.
 */
export const artifactLink = (href: string): ArtifactLink | undefined => {
  try {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return undefined;
    const library = /^\/artifacts\/(art_[0-9a-f]{32})\/?$/.exec(url.pathname);
    if (library !== null) return { artifactId: library[1] as string };
    const thread = /^\/threads\/(thr_[0-9a-f-]{36})\/?$/.exec(url.pathname);
    const artifactId = url.searchParams.get("artifact");
    if (thread === null || artifactId === null) return undefined;
    if (!ARTIFACT_ID.test(artifactId)) return undefined;
    return { threadId: thread[1] as ThreadId, artifactId };
  } catch {
    return undefined;
  }
};

/** Every artifact's one link, as the agent and Copy Link write it. */
export const artifactHref = (artifactId: string) => `/artifacts/${artifactId}`;

export interface ArtifactEmbedFrame {
  readonly id: number;
  readonly container: HTMLElement;
  readonly link: ArtifactLink;
}

export interface EmbedHost {
  /** The artifact being edited: a link to it does not embed itself. */
  readonly artifactId: string;
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
    if (link === undefined || link.artifactId === host.artifactId) return;
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
          key: `embed:${link.threadId ?? ""}:${link.artifactId}:${count}`,
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

/** Lines a document's preview shows. */
const PREVIEW_LINES = 6;

/**
 * A document's opening lines as plain text: Markdown marks, chips, and
 * blank lines dropped, so the preview reads like the document's start.
 */
export const documentExcerpt = (markdown: string) =>
  markdown
    .split("\n")
    .map((line) =>
      line
        .replace(
          /^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/,
          "",
        )
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/@\[([^\]]+)\]\([^)]*\)/g, "@$1")
        // A project chip reads as its Project's name, any other chip as its value.
        .replace(/\{\{project:[^|}]*\|([^}]*)\}\}/g, "$1")
        .replace(/\{\{[a-z]+(?:#[\w-]+)?:([^}|]*)[^}]*\}\}/g, "$1")
        .replace(/[*_`~]+/g, "")
        .trim(),
    )
    .filter((line) => line !== "" && !/^(```|~~~|---+|\|)/.test(line))
    .slice(0, PREVIEW_LINES)
    // A line repeats only with its own count, so each keeps one key.
    .map((text, index, all) => ({
      text,
      key: `${text}#${all.slice(0, index).filter((other) => other === text).length}`,
    }));
