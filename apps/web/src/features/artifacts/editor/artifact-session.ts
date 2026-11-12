/**
 * One open artifact's editing session: the editor's state, autosave, and
 * how a person's unsaved edits survive a newer revision.
 *
 * Every edit schedules a save (debounced) made from the revision the editor
 * last loaded (`baseRevision`). A save refused because someone saved a newer
 * revision, or a newer revision arriving live, rebases: the person's edits
 * are merged block by block onto the newer revision. When no block changed on
 * both sides the merge saves at once; otherwise both versions of each such
 * block are kept and flagged, and saving waits for the person to choose. A
 * draft is never dropped.
 *
 * A plain external store, read with `useSyncExternalStore`.
 */
import {
  ARTIFACT_IMAGE_MAX_BYTES,
  type ThreadArtifactComment,
  type ThreadMemberData,
} from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  type EditorState,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import { selectedRect } from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import {
  type PersonItem,
  peopleItems,
} from "../../../shared/comments/mention-items.js";
import type {
  SuggestMenuRow,
  SuggestMenuState,
} from "../../../shared/comments/suggest-menu.js";
import { threadKeys } from "../../threads/thread-queries.js";
import { acceptSavedArtifact } from "../artifact-document-queries.js";
import {
  ArtifactApiError,
  type ArtifactDocument,
  type ArtifactsApi,
  isArtifactConflict,
} from "../artifacts-api.js";
import { artifactKeys } from "../artifacts-queries.js";
import {
  type ArtifactMarkdownCodec,
  createArtifactMarkdownCodec,
} from "../markdown/artifact-markdown.js";
import { mergeArtifactMarkdown } from "../markdown/artifact-merge.js";
import {
  type Chip,
  mentionSource,
  newChipSource,
  parseChip,
  tryChipSource,
} from "../markdown/chips.js";
import {
  anchorRange,
  markdownOffset,
  quoteForSelection,
} from "../markdown/comment-anchors.js";
import {
  conflictFlagsKey,
  createArtifactEditorState,
} from "./artifact-editor-state.js";
import type {
  ArtifactEmbedFrame,
  ArtifactLink,
} from "./artifact-embed-links.js";
import {
  insertBlock,
  insertChip,
  selectionInTable,
  topLevelBlockAt,
} from "./block-commands.js";
import { chipTogglesKey } from "./chip-views.js";
import {
  type CommentRange,
  commentAt,
  commentHighlightsKey,
} from "./comment-highlights.js";
import { findKey, findMatches } from "./find.js";
import {
  type ImageUpload,
  imageUploads,
  imageUploadsKey,
  imageUploadsPlugin,
  putUpload,
  removeUpload,
} from "./image-uploads.js";
import { replaceDocument } from "./replace-document.js";
import {
  linkSelection,
  type SelectionBox,
  type SelectionMark,
  type SelectionMarks,
  selectionBox,
  selectionMarkdown,
  selectionMarks,
  toggleSelectionMark,
} from "./selection-format.js";
import { type SlashItem, slashItems } from "./suggest-items.js";
import {
  type SuggestHost,
  type SuggestItem,
  type SuggestMatch,
  suggestions,
  suggestKey,
} from "./suggestions.js";

export type ArtifactSaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "unsaved" }
  | { readonly kind: "saving" }
  /** A save failed; the draft is kept and the save retries. */
  | { readonly kind: "error"; readonly message: string }
  /** Both sides changed the same blocks; both versions are in the document. */
  | { readonly kind: "conflict"; readonly blocks: number };

export interface ArtifactSessionSnapshot {
  readonly save: ArtifactSaveState;
  /** The revision the editor's content is based on. */
  readonly revision: number;
  readonly title: string;
  /** Who saved the revision a merge brought in, while its notice shows. */
  readonly merged: ArtifactDocument["artifact"]["updatedBy"] | undefined;
  /** Where the selection is: its top-level block and whether it is in a table. */
  readonly selection: ArtifactSelection;
  /** Whether the document opens with a level-1 heading, which reads as its title. */
  readonly headed: boolean;
  /** The chip whose picker is open. */
  readonly chip: { readonly pos: number; readonly chip: Chip } | undefined;
  /** The `dx-view` blocks on screen, each framed into its container. */
  readonly views: ReadonlyArray<ArtifactViewFrame>;
  /** Artifacts embedded by a link on a line of its own, such as boards. */
  readonly embeds: ReadonlyArray<ArtifactEmbedFrame>;
  /** The open `/` or `@` menu: its options, the chosen one, and where it shows. */
  readonly suggest: ArtifactSuggestMenu | undefined;
  /** Every comment and reply, as last read. */
  readonly comments: ReadonlyArray<ThreadArtifactComment>;
  /** Open comments whose text the editor holds, and where. */
  readonly anchors: ReadonlyArray<CommentRange>;
  /** The comment chosen in the panel or in the text. */
  readonly activeComment: string | undefined;
  /** Find (#1810): open with its query, how many matches, and which is current. */
  readonly find?:
    | {
        readonly query: string;
        readonly count: number;
        readonly current: number;
      }
    | undefined;
}

/** One row of the open menu, as it shows. */
export type ArtifactSuggestRow = SuggestMenuRow;

/** The open `/` or `@` menu. */
export type ArtifactSuggestMenu = SuggestMenuState;

/** The menu's width and tallest height, and a row's and a heading's height. */
const SUGGEST_WIDTH = 260;
const SUGGEST_HEIGHT = 320;
const SUGGEST_ROW = 30;
const SUGGEST_HEADING = 24;

export interface ArtifactViewFrame {
  readonly id: number;
  readonly container: HTMLElement;
  readonly source: string;
}

export interface ArtifactTablePlacement {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly column: number;
  readonly row: number;
}

export interface ArtifactSelection {
  readonly inTable: boolean;
  /** Table controls relative to the page, clipped to its horizontal scroller. */
  readonly table?: ArtifactTablePlacement | undefined;
  /** Whether text is selected (something to comment on). */
  readonly ranged: boolean;
  /** The top-level block holding the selection, and its top in the page. */
  readonly block: { readonly pos: number; readonly top: number } | undefined;
  /** Selected text's place in the page, for the selection toolbar. */
  readonly box?: SelectionBox | undefined;
  /** The marks the selected text has. */
  readonly marks?: SelectionMarks | undefined;
  /** Whether the editor (or the selection's own toolbar) has focus. */
  readonly focused?: boolean;
}

const MESSAGE: Record<string, string> = {
  ARTIFACT_TOO_LARGE:
    "This artifact is over 2 MB, so it can't be saved. Your edits are kept here.",
  ARTIFACT_STORAGE_FULL:
    "This Thread's artifacts are full, so this can't be saved. Your edits are kept here.",
  THREAD_READ_ONLY: "You can view this artifact but not edit it.",
  ARTIFACT_NOT_FOUND: "This artifact was deleted. Your edits are kept here.",
};

/** Why an image could not be added, by the upload's error code. */
const IMAGE_MESSAGE: Record<string, string> = {
  ARTIFACT_IMAGE_INVALID: "Only PNG, JPEG, GIF, and WebP images can be added.",
  ARTIFACT_IMAGE_TOO_LARGE: "Images can be at most 10 MB.",
  THREAD_READ_ONLY: "You can view this artifact but not add images to it.",
};

const headed = (state: EditorState) => {
  const first = state.doc.firstChild;
  return first?.type.name === "heading" && first.attrs.level === 1;
};

const isArtifactDocument = (value: unknown): value is ArtifactDocument =>
  typeof value === "object" &&
  value !== null &&
  "artifact" in value &&
  "markdown" in value &&
  typeof value.markdown === "string";

const isCommentList = (
  value: unknown,
): value is ReadonlyArray<ThreadArtifactComment> =>
  Array.isArray(value) &&
  value.every(
    (comment: unknown) =>
      typeof comment === "object" &&
      comment !== null &&
      "id" in comment &&
      "quote" in comment &&
      "anchor" in comment,
  );

const retryable = (error: unknown) =>
  !(error instanceof ArtifactApiError) ||
  error.status >= 500 ||
  error.status === 408 ||
  error.status === 429;

export class ArtifactSession {
  readonly #threadId: ThreadId;
  readonly #artifactId: string;
  readonly #api: ArtifactsApi;
  readonly #queryClient: QueryClient;
  readonly #codec: ArtifactMarkdownCodec;
  readonly #delay: number;
  readonly #listeners = new Set<() => void>();
  #state: EditorState;
  /**
   * The views showing the session, newest last: one, or two for a moment
   * while a moved pane mounts its new view before the old one unmounts (or
   * two editors of one artifact on screen at once).
   */
  #shown: Array<{ readonly view: EditorView; readonly page: HTMLElement }> = [];

  /** The newest view, which places menus and the block handle. */
  get #view(): EditorView | undefined {
    return this.#shown.at(-1)?.view;
  }

  get #page(): HTMLElement | undefined {
    return this.#shown.at(-1)?.page;
  }
  /** The revision the editor's content is based on, and its Markdown. */
  #base: { revision: number; markdown: string; title: string; folder: string };
  #title: string;
  /** The folder the artifact is filed in; a move saves with the next save. */
  #folder: string;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight = false;
  #again = false;
  #held = false;
  /** Unmounted: nobody can review a conflict, so it saves both versions. */
  #detached = false;
  #failures = 0;
  #pendingRemote: ArtifactDocument | undefined;
  /** The merge a conflict came from, for Keep My Version. */
  #conflict: { base: string; mine: string; theirs: string } | undefined;
  #snapshot: ArtifactSessionSnapshot;

  constructor({
    threadId,
    initial,
    api,
    queryClient,
    delay = 800,
  }: {
    readonly threadId: ThreadId;
    readonly initial: ArtifactDocument;
    readonly api: ArtifactsApi;
    readonly queryClient: QueryClient;
    readonly delay?: number;
  }) {
    this.#threadId = threadId;
    this.#artifactId = initial.artifact.id;
    this.#api = api;
    this.#queryClient = queryClient;
    this.#delay = delay;
    this.#codec = createArtifactMarkdownCodec();
    this.#state = createArtifactEditorState(
      this.#codec.parse(initial.markdown),
      [suggestions(this.#suggestHost), imageUploadsPlugin(this.#uploadHost)],
    );
    this.#base = {
      revision: initial.artifact.revision,
      markdown: initial.markdown,
      title: initial.artifact.title,
      folder: initial.artifact.folder,
    };
    this.#title = initial.artifact.title;
    this.#folder = initial.artifact.folder;
    this.#snapshot = {
      save: { kind: "saved" },
      revision: initial.artifact.revision,
      title: initial.artifact.title,
      merged: undefined,
      selection: { inTable: false, ranged: false, block: undefined },
      headed: headed(this.#state),
      chip: undefined,
      views: [],
      embeds: [],
      suggest: undefined,
      comments: [],
      anchors: [],
      activeComment: undefined,
    };
  }

  // -- store -----------------------------------------------------------------

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.#snapshot;

  #publish(patch: Partial<ArtifactSessionSnapshot>) {
    this.#snapshot = {
      ...this.#snapshot,
      revision: this.#base.revision,
      title: this.#title,
      ...patch,
    };
    for (const listener of this.#listeners) listener();
  }

  // -- editor ----------------------------------------------------------------

  get state() {
    return this.#state;
  }

  /** Whether a view shows the session now. */
  get attached() {
    return this.#view !== undefined;
  }

  /** A view shows the session: the first, or one mounted after a move. */
  attach(view: EditorView, page: HTMLElement) {
    this.#shown = [
      ...this.#shown.filter((shown) => shown.view !== view),
      {
        view,
        page,
      },
    ];
    this.#detached = false;
    this.#trackSelection();
    this.#trackSuggest();
  }

  /** The top-level block at a point in the page, and its top, for the block handle. */
  blockAt(clientX: number, clientY: number) {
    const view = this.#view;
    if (view === undefined) return undefined;
    const box = view.dom.getBoundingClientRect();
    const found = view.posAtCoords({
      left: Math.min(Math.max(clientX, box.left + 8), box.right - 8),
      top: clientY,
    });
    if (found === null) return undefined;
    const block = topLevelBlockAt(
      this.#state,
      found.inside >= 0 ? found.inside : found.pos,
    );
    return block === undefined ? undefined : this.#placed(block.pos);
  }

  /**
   * Where a block dragged to `clientY` would land: before the top-level
   * block whose middle is below the pointer, or at the end; with the drop
   * line's place in the page.
   */
  dropAt(clientY: number) {
    const view = this.#view;
    const page = this.#page?.getBoundingClientRect();
    if (view === undefined || page === undefined) return undefined;
    const { doc } = this.#state;
    let pos = 0;
    let previousBottom: number | undefined;
    for (let index = 0; index < doc.childCount; index += 1) {
      const dom = view.nodeDOM(pos);
      const child = doc.child(index);
      if (dom instanceof HTMLElement) {
        const box = dom.getBoundingClientRect();
        if (clientY < box.top + box.height / 2)
          return {
            index,
            top:
              (previousBottom === undefined
                ? box.top - 4
                : (previousBottom + box.top) / 2) - page.top,
          };
        previousBottom = box.bottom;
      }
      pos += child.nodeSize;
    }
    return {
      index: doc.childCount,
      top: (previousBottom ?? page.top) + 4 - page.top,
    };
  }

  #placed(pos: number) {
    const view = this.#view;
    if (view === undefined || this.#page === undefined) return undefined;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return undefined;
    return {
      pos,
      top:
        dom.getBoundingClientRect().top -
        this.#page.getBoundingClientRect().top,
    };
  }

  #placedTable(): ArtifactTablePlacement | undefined {
    const view = this.#view;
    const page = this.#page;
    if (
      view === undefined ||
      page === undefined ||
      !selectionInTable(this.#state)
    )
      return undefined;
    const rect = selectedRect(this.#state);
    const dom = view.nodeDOM(rect.tableStart - 1);
    const cell = view.nodeDOM(
      rect.tableStart +
        (rect.map.map[rect.top * rect.map.width + rect.left] ?? 0),
    );
    if (!(dom instanceof HTMLElement) || !(cell instanceof HTMLElement))
      return undefined;
    const table = dom.querySelector("table") ?? dom;
    const box = table.getBoundingClientRect();
    const clip = dom.getBoundingClientRect();
    const at = cell.getBoundingClientRect();
    const origin = page.getBoundingClientRect();
    const left = Math.max(box.left, clip.left);
    const right = Math.min(box.right, clip.right);
    return {
      top: box.top - origin.top,
      left: left - origin.left,
      width: right - left,
      height: box.height,
      column:
        Math.max(left + 12, Math.min(right - 12, at.left + at.width / 2)) -
        origin.left,
      row: at.top + at.height / 2 - origin.top,
    };
  }

  /** The editor gained or lost focus: the selection's toolbar follows it. */
  readonly setFocused = (focused: boolean) => {
    const current = this.#snapshot.selection;
    if (current.focused === focused) return;
    this.#publish({ selection: { ...current, focused } });
  };

  /** Resize and nested table scrolling can move grips without a transaction. */
  readonly refreshLayout = () => this.#trackSelection();

  #trackSelection() {
    const block = topLevelBlockAt(this.#state, this.#state.selection.from);
    const placed = block === undefined ? undefined : this.#placed(block.pos);
    const inTable = selectionInTable(this.#state);
    const table = this.#placedTable();
    const ranged = !this.#state.selection.empty;
    const view = this.#view;
    const box =
      ranged && view !== undefined && this.#page !== undefined
        ? selectionBox(view, this.#page)
        : undefined;
    const marks = ranged ? selectionMarks(this.#state) : undefined;
    const current = this.#snapshot.selection;
    if (
      current.ranged === ranged &&
      current.inTable === inTable &&
      current.block?.pos === placed?.pos &&
      current.block?.top === placed?.top &&
      JSON.stringify(current.table) === JSON.stringify(table) &&
      JSON.stringify(current.box) === JSON.stringify(box) &&
      JSON.stringify(current.marks) === JSON.stringify(marks)
    )
      return;
    this.#publish({
      selection: {
        inTable,
        ranged,
        block: placed,
        table,
        box,
        marks,
        focused: current.focused === true,
      },
    });
  }

  /**
   * Called as the editor's view unmounts: saves what is unsaved, a conflict
   * still in review with both versions kept (a page closed before the next
   * view would otherwise lose the draft). The session stays for the next
   * view.
   */
  detach(view?: EditorView) {
    this.#shown =
      view === undefined
        ? []
        : this.#shown.filter((shown) => shown.view !== view);
    // Another view still shows it (the new pane of a move).
    if (this.#shown.length > 0) {
      this.#trackSelection();
      this.#trackSuggest();
      return;
    }
    this.#detached = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#held = false;
    this.#conflict = undefined;
    if (this.dirty) void this.#save();
  }

  /** No view will take the session again. */
  dispose() {
    if (this.attached) this.detach();
    else if (this.dirty) void this.#save();
  }

  /** The editor's Markdown now. */
  markdown() {
    return this.#codec.serialize(this.#state.doc);
  }

  /**
   * The Markdown to save: the editor's, without the `/query` or `@query` of
   * an open menu, which is a command being typed, not text.
   */
  #savable() {
    const match = suggestKey.getState(this.#state)?.match;
    if (match === undefined) return this.markdown();
    return this.#codec.serialize(
      this.#state.tr.delete(match.from, match.to).doc,
    );
  }

  /** Whether the editor holds edits no saved revision has. */
  get dirty() {
    return (
      this.#title !== this.#base.title ||
      this.#folder !== this.#base.folder ||
      this.#savable() !== this.#base.markdown
    );
  }

  /** Every editor transaction comes through here. */
  readonly dispatch = (tr: Transaction) => {
    this.#state = this.#state.apply(tr);
    for (const { view } of this.#shown) view.updateState(this.#state);
    if (tr.docChanged && tr.getMeta("artifact-remote") !== true) this.#edited();
    if (tr.docChanged && headed(this.#state) !== this.#snapshot.headed)
      this.#publish({ headed: headed(this.#state) });
    if (tr.docChanged || tr.selectionSet) this.#trackSelection();
    if (tr.docChanged) this.#trackAnchors();
    if (tr.docChanged) this.#trackFind();
    this.#trackSuggest();
    const open = this.#snapshot.chip;
    if (open !== undefined && tr.docChanged) {
      const mapped = tr.mapping.mapResult(open.pos, 1);
      const pos = mapped.pos;
      const node = mapped.deletedAfter ? null : this.#state.doc.nodeAt(pos);
      const chip =
        node?.type.name === "chip"
          ? parseChip(String(node.attrs.source))
          : undefined;
      this.#publish({ chip: chip === undefined ? undefined : { pos, chip } });
    }
  };

  #edited() {
    if (this.#held) return;
    this.#publish({ save: { kind: "unsaved" }, merged: undefined });
    this.#schedule(this.#delay);
  }

  #schedule(delay: number) {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#save();
    }, delay);
  }

  // -- chips and views -------------------------------------------------------

  /** A chip was clicked: a toggle flips for this reader; others open a picker. */
  readonly onChip = (pos: number, chip: Chip) => {
    if (chip.kind === "toggle") {
      this.dispatch(
        this.#state.tr
          .setMeta(chipTogglesKey, chip.key)
          .setMeta("addToHistory", false),
      );
      return;
    }
    if (chip.kind === "mention" || chip.kind === "agent") return;
    this.#publish({ chip: { pos, chip } });
  };

  readonly closeChip = () => {
    if (this.#snapshot.chip !== undefined) this.#publish({ chip: undefined });
  };

  /** Writes a new value into the chip at `pos`; the picker stays open on it. */
  setChip(pos: number, chip: Chip) {
    const node = this.#state.doc.nodeAt(pos);
    // A value typed halfway (a year of 0002) is not written.
    const source = tryChipSource(chip);
    if (node?.type.name !== "chip" || source === undefined) return;
    this.dispatch(this.#state.tr.setNodeMarkup(pos, null, { source }));
    this.#publish({ chip: { pos, chip } });
  }

  /** Deletes the chip at `pos` (Remove Dropdown) and closes its picker. */
  removeChip(pos: number) {
    const node = this.#state.doc.nodeAt(pos);
    if (node?.type.name !== "chip") return;
    this.#publish({ chip: undefined });
    this.dispatch(this.#state.tr.delete(pos, pos + node.nodeSize));
    this.#view?.focus();
  }

  /** The chip's element, which its picker is placed against. */
  readonly chipElement = (pos: number) => {
    const dom = this.#view?.nodeDOM(pos);
    return dom instanceof Element ? dom : null;
  };

  #embeds = 0;
  /** Shows a linked artifact in `container`, a widget below its link. */
  readonly showEmbed = (container: HTMLElement, link: ArtifactLink) => {
    this.#embeds += 1;
    const id = this.#embeds;
    this.#publish({
      embeds: [...this.#snapshot.embeds, { id, container, link }],
    });
    return () =>
      this.#publish({
        embeds: this.#snapshot.embeds.filter((embed) => embed.id !== id),
      });
  };

  #views = 0;
  /** Frames a `dx-view` block's HTML into `container` (rendered by the editor). */
  readonly showView = (container: HTMLElement, source: string) => {
    this.#views += 1;
    const id = this.#views;
    this.#publish({
      views: [...this.#snapshot.views, { id, container, source }],
    });
    return {
      update: (next: string) => {
        const frame = this.#snapshot.views.find((view) => view.id === id);
        if (frame === undefined || frame.source === next) return;
        this.#publish({
          views: this.#snapshot.views.map((view) =>
            view.id === id ? { ...view, source: next } : view,
          ),
        });
      },
      remove: () =>
        this.#publish({
          views: this.#snapshot.views.filter((view) => view.id !== id),
        }),
    };
  };

  /**
   * A click or tap below the last block: the caret goes into an empty
   * paragraph at the end, added unless the document already ends with one.
   */
  readonly focusEnd = () => {
    const view = this.#view;
    if (view === undefined) return;
    const { doc } = this.#state;
    const last = doc.lastChild;
    const tr = this.#state.tr;
    if (!(last?.type.name === "paragraph" && last.childCount === 0))
      tr.insert(doc.content.size, doc.type.schema.nodes.paragraph.create());
    this.dispatch(
      tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView(),
    );
    view.focus();
  };

  // -- `/` and `@` ------------------------------------------------------------

  #people: ReadonlyArray<ThreadMemberData> = [];
  #viewerId = "";

  readonly #suggestHost: SuggestHost = {
    items: (match) =>
      match.kind === "slash"
        ? slashItems(match.query)
        : peopleItems(match.query, this.#people, this.#viewerId),
    pick: (view, match, item) => this.#pick(view, match, item),
  };

  /** Shows the open menu, placed under its trigger. */
  #trackSuggest() {
    const value = suggestKey.getState(this.#state);
    const match = value?.match;
    const view = this.#view;
    let next: ArtifactSuggestMenu | undefined;
    if (
      match !== undefined &&
      value !== undefined &&
      view !== undefined &&
      this.#page !== undefined
    ) {
      const items = this.#suggestHost.items(match) as ReadonlyArray<
        SlashItem | PersonItem
      >;
      const at = view.coordsAtPos(match.from);
      const page = this.#page.getBoundingClientRect();
      // Below the trigger, or above it when the editor has more room there
      // than below and not enough below for the whole menu.
      const room = (
        this.#page.parentElement ?? this.#page
      ).getBoundingClientRect();
      const below = room.bottom - at.bottom - 12;
      const above = at.top - room.top - 12;
      const groups = new Set(
        items.map((item) => ("group" in item ? item.group : undefined)),
      );
      const wanted = Math.min(
        SUGGEST_HEIGHT,
        Math.max(1, items.length) * SUGGEST_ROW +
          (groups.has(undefined) ? 0 : groups.size * SUGGEST_HEADING) +
          10,
      );
      const up = below < wanted && above > below;
      next = {
        kind: match.kind,
        items: items.map((item) => ({
          id: item.id,
          label: item.label,
          ...(item.hint === undefined ? {} : { hint: item.hint }),
          ...("group" in item ? { group: item.group } : {}),
          ...("shortcut" in item && item.shortcut !== undefined
            ? { shortcut: item.shortcut }
            : {}),
          ...("userId" in item && item.userId !== undefined
            ? { userId: item.userId }
            : {}),
          ...("image" in item && item.image !== undefined
            ? { image: item.image }
            : {}),
        })),
        active: Math.min(value.active, Math.max(0, items.length - 1)),
        top: up ? at.top - page.top - 4 : at.bottom - page.top + 4,
        left: Math.max(
          0,
          Math.min(at.left - page.left, page.width - SUGGEST_WIDTH),
        ),
        above: up,
        maxHeight: Math.max(
          SUGGEST_ROW * 3,
          Math.min(SUGGEST_HEIGHT, up ? above : below),
        ),
      };
    }
    if (JSON.stringify(next) !== JSON.stringify(this.#snapshot.suggest))
      this.#publish({ suggest: next });
  }

  // -- images ----------------------------------------------------------------

  /** Files on their way, by upload, kept for Retry. */
  readonly #files = new Map<string, File>();
  #uploads = 0;
  /** Opens the file picker; the editor sets it while it is mounted. */
  #imagePicker: (() => void) | undefined;

  readonly #uploadHost = {
    retry: (id: string) => void this.#upload(id),
    remove: (id: string) => {
      this.#files.delete(id);
      this.dispatch(removeUpload(this.#state, id));
    },
  };

  /** Lets Insert Image (toolbar or `/`) open the editor's file picker. */
  setImagePicker(open: () => void) {
    this.#imagePicker = open;
    return () => {
      if (this.#imagePicker === open) this.#imagePicker = undefined;
    };
  }

  readonly pickImage = () => this.#imagePicker?.();

  /**
   * Where an image added at `pos` goes: a block after the text there, or
   * inline when the text's container takes no other block (a table cell).
   */
  #imageTarget(pos: number) {
    const $pos = this.#state.doc.resolve(pos);
    let depth = $pos.depth;
    while (depth > 0 && !$pos.node(depth).isTextblock) depth -= 1;
    if (depth === 0) return { pos, inline: false };
    const container = $pos.node(depth - 1);
    const index = $pos.index(depth - 1);
    return container.canReplaceWith(
      index + 1,
      index + 1,
      this.#state.schema.nodes.paragraph,
    )
      ? { pos: $pos.after(depth), inline: false }
      : { pos: $pos.pos, inline: true };
  }

  /** Uploads images (picked, pasted, or dropped at `at`) into the document. */
  readonly uploadImages = (files: ReadonlyArray<File>, at?: number) => {
    const target = this.#imageTarget(at ?? this.#state.selection.to);
    for (const file of files) {
      this.#uploads += 1;
      const id = `upload-${this.#uploads}`;
      this.#files.set(id, file);
      this.dispatch(
        putUpload(this.#state, {
          id,
          name: file.name || "image",
          ...target,
          status: { kind: "uploading", share: 0 },
        }),
      );
      void this.#upload(id);
    }
  };

  #currentUpload(id: string): ImageUpload | undefined {
    return imageUploads(this.#state).find((upload) => upload.id === id);
  }

  async #upload(id: string) {
    const file = this.#files.get(id);
    const set = (status: ImageUpload["status"]) => {
      const current = this.#currentUpload(id);
      if (current !== undefined)
        this.dispatch(putUpload(this.#state, { ...current, status }));
    };
    if (file === undefined) return;
    if (file.size > ARTIFACT_IMAGE_MAX_BYTES) {
      set({ kind: "failed", message: "Images can be at most 10 MB." });
      return;
    }
    set({ kind: "uploading", share: 0 });
    let image: { readonly url: string } | undefined;
    try {
      image = await this.#api.uploadImage(this.#threadId, file, (share) =>
        set({ kind: "uploading", share }),
      );
    } catch (error) {
      const code = error instanceof ArtifactApiError ? error.code : "";
      set({
        kind: "failed",
        message:
          IMAGE_MESSAGE[code] ??
          "Couldn't upload. Retry when the connection is back.",
      });
      return;
    }
    // Removed while it uploaded: nothing to place.
    const current = this.#currentUpload(id);
    if (current === undefined) return;
    this.#files.delete(id);
    const { schema } = this.#state;
    const node = schema.nodes.image.create({
      src: image.url,
      alt: (file.name || "image").replace(/\.[^.]+$/, ""),
    });
    const tr = this.#state.tr;
    if (current.inline) tr.insert(current.pos, node);
    else {
      // An empty line just above takes the image; otherwise it gets its own.
      const before = tr.doc.resolve(current.pos).nodeBefore;
      const block = schema.nodes.paragraph.create(null, node);
      if (before?.type.name === "paragraph" && before.childCount === 0)
        tr.replaceWith(current.pos - before.nodeSize, current.pos, block);
      else tr.insert(current.pos, block);
    }
    tr.setMeta(imageUploadsKey, { remove: id });
    this.dispatch(tr);
  }

  /** Sets an image's alt text. */
  readonly setImageAlt = (pos: number, alt: string) => {
    const node = this.#state.doc.nodeAt(pos);
    if (node?.type.name !== "image" || node.attrs.alt === alt) return;
    this.dispatch(
      this.#state.tr.setNodeMarkup(pos, null, { ...node.attrs, alt }),
    );
  };

  /** Replaces the typed `/query` or `@query` with what was picked. */
  #pick(view: EditorView, match: SuggestMatch, item: SuggestItem) {
    view.dispatch(this.#state.tr.delete(match.from, match.to));
    let tr: Transaction | undefined;
    if (match.kind === "mention") {
      const person = item as PersonItem;
      const source =
        person.userId === undefined
          ? "@[dx](agent)"
          : mentionSource({ name: person.label, userId: person.userId });
      if (source !== undefined) tr = insertChip(this.#state, source);
    } else {
      const { action } = item as SlashItem;
      if (action.kind === "image") this.pickImage();
      else
        tr =
          action.kind === "block"
            ? insertBlock(this.#state, action.block)
            : insertChip(this.#state, newChipSource(action.chip));
    }
    if (tr !== undefined) view.dispatch(tr);
    view.focus();
  }

  /** The pointer over an option of the open menu makes it the active one. */
  readonly highlightSuggestion = (index: number) => {
    const view = this.#view;
    if (
      view === undefined ||
      suggestKey.getState(this.#state)?.active === index
    )
      return;
    view.dispatch(this.#state.tr.setMeta(suggestKey, { select: index }));
  };

  /** A click or tap on an option of the open menu. */
  readonly pickSuggestion = (index: number) => {
    const view = this.#view;
    const match = suggestKey.getState(this.#state)?.match;
    if (view === undefined || match === undefined) return;
    const item = this.#suggestHost.items(match)[index];
    if (item !== undefined) this.#pick(view, match, item);
  };

  /** Keeps `@` following the Thread's people (its members query). */
  followPeople(viewerId: string) {
    this.#viewerId = viewerId;
    const key = threadKeys.members(viewerId as UserId, this.#threadId);
    const take = (data: unknown) => {
      if (Array.isArray(data))
        this.#people = data as ReadonlyArray<ThreadMemberData>;
    };
    take(this.#queryClient.getQueryData(key));
    const id = JSON.stringify(key);
    return this.#queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        JSON.stringify(event.query.queryKey) === id
      )
        take(event.query.state.data);
    });
  }

  /** Renames the artifact with its next save. */
  rename(title: string) {
    const next = title.trim();
    if (next === "" || next === this.#title) return;
    this.#title = next;
    this.#edited();
  }

  /** Files the artifact in `folder` ("" for none), saving at once. */
  moveTo(folder: string) {
    const next = folder.trim();
    if (next === this.#folder) return;
    this.#folder = next;
    this.#edited();
    this.flush();
  }

  /** Saves now (Mod-S, or leaving the page). */
  flush() {
    if (this.#held) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    void this.#save();
  }

  // -- saving ----------------------------------------------------------------

  async #save() {
    if (this.#inFlight) {
      this.#again = true;
      return;
    }
    const markdown = this.#savable();
    const title = this.#title;
    const folder = this.#folder;
    if (
      markdown === this.#base.markdown &&
      title === this.#base.title &&
      folder === this.#base.folder
    ) {
      this.#publish({ save: { kind: "saved" } });
      return;
    }
    this.#inFlight = true;
    this.#again = false;
    this.#publish({ save: { kind: "saving" } });
    const base = this.#base;
    let outcome:
      | { readonly saved: ArtifactDocument }
      | { readonly error: unknown };
    try {
      outcome = {
        saved: await this.#api.save(this.#threadId, this.#artifactId, {
          baseRevision: base.revision,
          markdown,
          ...(title === base.title ? {} : { title }),
          ...(folder === base.folder ? {} : { folder }),
        }),
      };
    } catch (error) {
      outcome = { error };
    }
    this.#inFlight = false;
    if ("saved" in outcome) {
      this.#failures = 0;
      const { saved } = outcome;
      this.#base = {
        revision: saved.artifact.revision,
        markdown: saved.markdown,
        title: saved.artifact.title,
        folder: saved.artifact.folder,
      };
      acceptSavedArtifact(this.#queryClient, this.#threadId, saved);
      // The server stores the Markdown it was sent; should it ever differ,
      // the editor shows what was stored.
      if (saved.markdown !== markdown && this.#savable() === markdown)
        this.#load(saved.markdown, []);
    } else if (isArtifactConflict(outcome.error)) {
      this.#rebase(outcome.error.current);
      return;
    } else {
      const { error } = outcome;
      const code = error instanceof ArtifactApiError ? error.code : "";
      this.#publish({
        save: {
          kind: "error",
          message:
            MESSAGE[code] ??
            "Couldn't save. Your edits are kept here and will save when the connection is back.",
        },
      });
      if (retryable(error)) {
        this.#failures += 1;
        this.#schedule(Math.min(30_000, 1_000 * 2 ** this.#failures));
      }
      this.#applyPending();
      return;
    }
    this.#applyPending();
    if (this.#held) return;
    if (this.#again || this.dirty) {
      this.#publish({ save: { kind: "unsaved" } });
      this.#schedule(this.#again ? 0 : this.#delay);
    } else this.#publish({ save: { kind: "saved" } });
  }

  /**
   * Loads `markdown` into the editor, changing only the blocks that differ,
   * and flags the top-level blocks at `conflicts`.
   */
  #load(markdown: string, conflicts: ReadonlyArray<number>) {
    const next = this.#codec.parse(markdown);
    const tr = replaceDocument(this.#state, next);
    const keys = new Set<number>();
    for (const index of conflicts) {
      const key = next.maybeChild(index)?.attrs.key;
      if (typeof key === "number") keys.add(key);
    }
    tr.setMeta(conflictFlagsKey, keys);
    tr.setMeta("artifact-remote", true);
    tr.setMeta("addToHistory", false);
    this.dispatch(tr);
    this.#placeComments();
  }

  /** Re-applies the person's edits on top of a newer revision. */
  #rebase(current: ArtifactDocument) {
    const mine = this.markdown();
    const baseMarkdown = this.#base.markdown;
    const merge = mergeArtifactMarkdown({
      base: baseMarkdown,
      mine,
      theirs: current.markdown,
    });
    const keepTitle = this.#title !== this.#base.title;
    const keepFolder = this.#folder !== this.#base.folder;
    this.#base = {
      revision: current.artifact.revision,
      markdown: current.markdown,
      title: current.artifact.title,
      folder: current.artifact.folder,
    };
    if (!keepTitle) this.#title = current.artifact.title;
    if (!keepFolder) this.#folder = current.artifact.folder;
    acceptSavedArtifact(this.#queryClient, this.#threadId, current);
    this.#load(merge.markdown, merge.conflicts);
    if (merge.conflicts.length > 0 && !this.#detached) {
      this.#held = true;
      this.#conflict = {
        base: baseMarkdown,
        mine,
        theirs: current.markdown,
      };
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#publish({
        save: { kind: "conflict", blocks: merge.conflicts.length },
        merged: current.artifact.updatedBy,
      });
      return;
    }
    this.#publish({ merged: current.artifact.updatedBy });
    if (this.dirty) {
      this.#publish({ save: { kind: "unsaved" } });
      this.#schedule(0);
    } else this.#publish({ save: { kind: "saved" } });
  }

  /** A revision read from the server: newer ones replace or rebase the editor. */
  receive(remote: ArtifactDocument) {
    if (remote.artifact.id !== this.#artifactId) return;
    if (remote.artifact.revision <= this.#base.revision) return;
    // Mid-save, or while the person reviews a conflict, a newer revision
    // waits: the next save meets it as a conflict and merges it.
    if (this.#inFlight || this.#held) {
      if (
        this.#pendingRemote === undefined ||
        this.#pendingRemote.artifact.revision < remote.artifact.revision
      )
        this.#pendingRemote = remote;
      return;
    }
    if (!this.#held && !this.dirty) {
      this.#base = {
        revision: remote.artifact.revision,
        markdown: remote.markdown,
        title: remote.artifact.title,
        folder: remote.artifact.folder,
      };
      this.#title = remote.artifact.title;
      this.#folder = remote.artifact.folder;
      this.#load(remote.markdown, []);
      this.#publish({ save: { kind: "saved" }, merged: undefined });
      return;
    }
    this.#rebase(remote);
  }

  #applyPending() {
    const remote = this.#pendingRemote;
    this.#pendingRemote = undefined;
    if (remote !== undefined) this.receive(remote);
  }

  /** Conflict: keep the document as merged (both versions), and save it. */
  keepBoth() {
    if (!this.#held) return;
    this.#held = false;
    this.#conflict = undefined;
    const tr = this.#state.tr.setMeta(conflictFlagsKey, new Set<number>());
    tr.setMeta("addToHistory", false);
    this.dispatch(tr);
    this.#publish({ save: { kind: "unsaved" } });
    this.#schedule(0);
  }

  /**
   * Conflict: where both sides changed a block, keep the person's version;
   * the other side's changes to other blocks stay.
   */
  keepMine() {
    const conflict = this.#conflict;
    if (!this.#held || conflict === undefined) return;
    this.#held = false;
    this.#conflict = undefined;
    this.#load(
      mergeArtifactMarkdown({ ...conflict, prefer: "mine" }).markdown,
      [],
    );
    this.#publish({ save: { kind: "unsaved" } });
    this.#schedule(0);
  }

  // -- comments --------------------------------------------------------------

  /** Shows each open comment on the text it sits on. */
  /** Where a document position falls in the Markdown the editor would save. */
  readonly #offsetOf = (pos: number) =>
    markdownOffset(this.#codec, this.#state.doc, pos);

  /** Each placed comment's anchor as the server gave it, to tell when it moved. */
  #placedFrom = new Map<string, string>();

  #placeComments() {
    const mapped = new Map(
      (commentHighlightsKey.getState(this.#state)?.ranges ?? []).map(
        (range) => [range.id, range] as const,
      ),
    );
    const placedFrom = new Map<string, string>();
    const anchors = this.#snapshot.comments.flatMap((comment) => {
      if (
        comment.parentId !== null ||
        comment.resolvedAt !== null ||
        comment.anchor === null
      )
        return [];
      // A highlight already placed for this anchor has followed every edit
      // since; keep it rather than search again.
      const from = `${comment.anchor.revision}:${comment.anchor.start}`;
      placedFrom.set(comment.id, from);
      const kept = mapped.get(comment.id);
      if (kept !== undefined && this.#placedFrom.get(comment.id) === from)
        return [kept];
      const range = anchorRange(
        this.#state.doc,
        this.#base.markdown,
        {
          quote: comment.quote,
          start: comment.anchor.start,
          end: comment.anchor.end,
        },
        this.#offsetOf,
      );
      return range === undefined ? [] : [{ id: comment.id, ...range }];
    });
    this.#placedFrom = placedFrom;
    this.dispatch(
      this.#state.tr
        .setMeta(commentHighlightsKey, { ranges: anchors })
        .setMeta("addToHistory", false),
    );
    this.#publish({ anchors });
  }

  /** The anchors as edits since they were placed have moved them. */
  #trackAnchors() {
    const anchors = commentHighlightsKey.getState(this.#state)?.ranges ?? [];
    const shown = this.#snapshot.anchors;
    if (anchors !== shown && (anchors.length > 0 || shown.length > 0))
      this.#publish({ anchors });
  }

  /** Chooses a comment and brings its text into view. */
  readonly selectComment = (id: string | undefined) => {
    this.dispatch(
      this.#state.tr
        .setMeta(commentHighlightsKey, { active: id })
        .setMeta("addToHistory", false),
    );
    this.#publish({ activeComment: id });
    const range = this.#snapshot.anchors.find((anchor) => anchor.id === id);
    const view = this.#view;
    if (range === undefined || view === undefined) return;
    const { node } = view.domAtPos(range.from);
    const element = node instanceof Element ? node : node.parentElement;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // -- find ---------------------------------------------------------------

  /** Opens Find, or changes its query; the first match becomes current. */
  readonly find = (query: string) => this.#showFind(query, 0);

  /** Moves to the next (1) or previous (-1) match, wrapping around. */
  readonly findStep = (step: 1 | -1) => {
    const find = this.#snapshot.find;
    if (find === undefined || find.count === 0) return;
    this.#showFind(find.query, (find.current + step + find.count) % find.count);
  };

  readonly closeFind = () => {
    this.dispatch(
      this.#state.tr
        .setMeta(findKey, { query: "", current: 0 })
        .setMeta("addToHistory", false),
    );
    this.#publish({ find: undefined });
  };

  #showFind(query: string, current: number) {
    const matches = findMatches(this.#state.doc, query);
    const at = matches.length === 0 ? 0 : Math.min(current, matches.length - 1);
    this.dispatch(
      this.#state.tr
        .setMeta(findKey, { query, current: at })
        .setMeta("addToHistory", false),
    );
    this.#publish({ find: { query, count: matches.length, current: at } });
    const match = matches[at];
    const view = this.#view;
    if (match === undefined || view === undefined) return;
    const { node } = view.domAtPos(match.from);
    const element = node instanceof Element ? node : node.parentElement;
    element?.scrollIntoView({ block: "nearest" });
  }

  /** Edits move the matches: recount, keeping the current one in range. */
  #trackFind() {
    const find = this.#snapshot.find;
    if (find === undefined) return;
    const count = findMatches(this.#state.doc, find.query).length;
    if (count === find.count) return;
    const current = count === 0 ? 0 : Math.min(find.current, count - 1);
    this.#publish({ find: { query: find.query, count, current } });
    this.dispatch(
      this.#state.tr
        .setMeta(findKey, { query: find.query, current })
        .setMeta("addToHistory", false),
    );
  }

  /** Leaves the caret at the end of the selection, selecting nothing. */
  readonly collapseSelection = () => {
    const { to, empty } = this.#state.selection;
    if (empty) return;
    this.dispatch(
      this.#state.tr
        .setSelection(TextSelection.create(this.#state.doc, to))
        .setMeta("addToHistory", false),
    );
  };

  /** Marks the selection as the text a new comment is on, or clears it. */
  readonly markCommentDraft = (on: boolean) => {
    const { from, to } = this.#state.selection;
    this.dispatch(
      this.#state.tr
        .setMeta(commentHighlightsKey, {
          draft: on && from < to ? { from, to } : undefined,
        })
        .setMeta("addToHistory", false),
    );
  };

  /** The highlighted text of a comment (or of the draft), for its card. */
  readonly commentElement = (id: string): Element | null =>
    this.#view?.dom.querySelector(`[data-comment="${CSS.escape(id)}"]`) ?? null;

  /** The comment whose highlighted text holds `pos`. */
  readonly commentAt = (pos: number) => commentAt(this.#snapshot.anchors, pos);

  /** Resolves once the editor's content is saved; false if it cannot be now. */
  #whenSaved(): Promise<boolean> {
    const settled = () => {
      const kind = this.#snapshot.save.kind;
      if (kind === "saved" && !this.dirty) return true;
      // A conflict waits for the person; a failed save for the connection.
      if (kind === "error" || kind === "conflict") return false;
      return undefined;
    };
    const now = settled();
    if (now !== undefined) return Promise.resolve(now);
    this.flush();
    const flushed = settled();
    if (flushed !== undefined) return Promise.resolve(flushed);
    return new Promise((resolve) => {
      const stop = this.subscribe(() => {
        const kind = this.#snapshot.save.kind;
        if (kind === "saved" && !this.dirty) {
          stop();
          resolve(true);
        } else if (kind === "error" || kind === "conflict") {
          stop();
          resolve(false);
        }
      });
    });
  }

  /** Bold, Italic, Strikethrough, or Code on the selection, keeping it. */
  formatSelection(mark: SelectionMark) {
    const view = this.#view;
    if (view !== undefined) toggleSelectionMark(view, mark);
  }

  /** Links the selection, or unlinks it for `""`; false for an unsafe link. */
  linkSelection(input: string) {
    const view = this.#view;
    return view === undefined ? false : linkSelection(view, input);
  }

  /** The selection as Markdown, for Copy as Markdown and Send to Thread. */
  selectionMarkdown() {
    return this.#state.selection.empty ? "" : selectionMarkdown(this.#state);
  }

  /**
   * The quote for a comment on the selection, saving first so the server's
   * revision holds the selected text. Undefined when nothing selected can be
   * quoted.
   */
  async quoteSelection(): Promise<
    { readonly quote: string; readonly near: number } | "unsaved" | undefined
  > {
    const { from, to } = this.#state.selection;
    if (from === to) return undefined;
    if (!(await this.#whenSaved())) return "unsaved";
    const { from: start, to: end } = this.#state.selection;
    return quoteForSelection(
      this.#state.doc,
      start,
      end,
      this.#base.markdown,
      this.#offsetOf,
    );
  }

  /** Keeps the comments following their query. */
  followComments() {
    const key = JSON.stringify(
      artifactKeys.comments(this.#threadId, this.#artifactId),
    );
    const take = (data: unknown) => {
      // The same data again (a refetch that changed nothing) moves nothing.
      if (!isCommentList(data) || data === this.#snapshot.comments) return;
      this.#publish({ comments: data });
      this.#placeComments();
    };
    take(
      this.#queryClient.getQueryData(
        artifactKeys.comments(this.#threadId, this.#artifactId),
      ),
    );
    return this.#queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        JSON.stringify(event.query.queryKey) === key
      )
        take(event.query.state.data);
    });
  }

  /**
   * Keeps the editor following the artifact's query, for live updates,
   * starting from what it holds now (a revision saved while no view had the
   * session).
   */
  followQuery() {
    const key = JSON.stringify(
      artifactKeys.detail(this.#threadId, this.#artifactId),
    );
    const current: unknown = this.#queryClient.getQueryData(
      artifactKeys.detail(this.#threadId, this.#artifactId),
    );
    if (isArtifactDocument(current)) this.receive(current);
    return this.#queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        JSON.stringify(event.query.queryKey) !== key
      )
        return;
      const data: unknown = event.query.state.data;
      if (isArtifactDocument(data)) this.receive(data);
    });
  }
}
