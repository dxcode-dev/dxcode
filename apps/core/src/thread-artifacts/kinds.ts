import type { ThreadArtifactKind } from "@dx/api";
import {
  type BoardDocument,
  boardElementLabel,
  boardFromText,
  boardToText,
  liveBoardElements,
  parseBoard,
  serializeBoard,
} from "@dx/domain";

/**
 * What differs between artifact types. Everything else (revisions and their
 * compare-and-swap, retention, comments, sharing, notifications, the agent's
 * `artifact` tool) is shared and asks the type only these questions. A new
 * type (a flowchart, a mind map) adds a value to `ARTIFACT_KINDS`, a handler
 * here, and an editor in the web app's kinds registry.
 */
export interface ArtifactKindHandler {
  readonly kind: ThreadArtifactKind;
  /** The R2 object's content type. */
  readonly contentType: string;
  /**
   * Whether every revision a person saved is kept. A document's are; a
   * board saves after each gesture, so it keeps only its newest revisions.
   */
  readonly keepsEveryPersonRevision: boolean;
  /** A new artifact's body when the creator gives none. */
  readonly emptyBody: () => string;
  /** Checks a body people or the agent save, and returns it as stored. */
  readonly check: (
    body: string,
  ) =>
    | { readonly ok: true; readonly body: string }
    | { readonly ok: false; readonly message: string };
  /**
   * The body as the agent and the after-save effects (asks, mentions,
   * people's diffs) read it: lines of text.
   */
  readonly toText: (body: string) => string;
  /** The agent's text, applied to the current body. */
  readonly fromText: (
    text: string,
    current: string,
  ) =>
    | { readonly ok: true; readonly body: string }
    | { readonly ok: false; readonly message: string };
  /**
   * Comments sit on quoted text (`quote`), or on a part of the artifact by
   * id (`target`), such as a board's shape.
   */
  readonly comments: "quote" | "target";
  /**
   * For `target` comments: what the target is called now, or undefined
   * when it is gone. `quote` resolves an agent's `quote` (an id or the
   * target's words) to a target.
   */
  readonly target?: {
    readonly label: (body: string, target: string) => string | undefined;
    readonly find: (body: string, quote: string) => string | undefined;
  };
}

const document: ArtifactKindHandler = {
  kind: "document",
  contentType: "text/markdown; charset=utf-8",
  keepsEveryPersonRevision: true,
  emptyBody: () => "",
  check: (body) => ({ ok: true, body }),
  toText: (body) => body,
  fromText: (text) => ({ ok: true, body: text }),
  comments: "quote",
};

const boardOf = (body: string): BoardDocument => {
  const parsed = parseBoard(body);
  if (!parsed.ok) throw new Error(`Stored board is invalid: ${parsed.message}`);
  return parsed.board;
};

const board: ArtifactKindHandler = {
  kind: "board",
  contentType: "application/json",
  keepsEveryPersonRevision: false,
  emptyBody: () => serializeBoard(boardOf("")),
  check: (body) => {
    const parsed = parseBoard(body);
    return parsed.ok
      ? { ok: true, body: serializeBoard(parsed.board) }
      : parsed;
  },
  toText: (body) => boardToText(boardOf(body)),
  fromText: (text, current) => {
    const result = boardFromText(text, boardOf(current));
    return result.ok
      ? { ok: true, body: serializeBoard(result.board) }
      : result;
  },
  comments: "target",
  target: {
    label: (body, target) => boardElementLabel(boardOf(body), target),
    find: (body, quote) => {
      const scene = boardOf(body);
      const live = liveBoardElements(scene);
      const wanted = quote.trim();
      const byId = live.find(({ id }) => id === wanted);
      if (byId !== undefined)
        // A label's comment sits on its shape.
        return byId.containerId ?? byId.id;
      const lower = wanted.toLowerCase();
      const byText = live.find(
        (element) =>
          typeof element.text === "string" &&
          element.text.toLowerCase().includes(lower),
      );
      return byText === undefined
        ? undefined
        : (byText.containerId ?? byText.id);
    },
  },
};

const HANDLERS: Record<ThreadArtifactKind, ArtifactKindHandler> = {
  document,
  board,
};

export const artifactKind = (kind: ThreadArtifactKind) => HANDLERS[kind];
