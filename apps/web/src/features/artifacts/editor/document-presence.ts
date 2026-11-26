/**
 * Live carets in a document artifact: where the viewer's caret and
 * selection are goes out to the others who have it open, and theirs come
 * in and show as decorations, in each person's color with their name.
 * Nothing here is stored or saved.
 *
 * A place travels as a text block's index, an offset into it, and the
 * block's opening text, not as a document position, because each screen
 * may hold edits the others have not received yet. The opening text finds
 * the block again when blocks above it were added or removed.
 */
import type { BoardLivePayload } from "@dx/api";
import { useQueryClient } from "@tanstack/react-query";
import type { Node } from "prosemirror-model";
import { type EditorState, Selection } from "prosemirror-state";
import { Decoration, type EditorView } from "prosemirror-view";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import {
  type BoardLiveChannel,
  type BoardLiveEvent,
  useBoardLiveChannel,
} from "../../../shared/realtime/live.js";
import {
  ArtifactPeople,
  type CursorPerson,
  collaboratorColor,
} from "../artifact-people.js";
import type { ArtifactScope } from "../artifact-scope.js";
import type { ArtifactDocument } from "../artifacts-api-queries.js";

type Caret = NonNullable<BoardLivePayload["caret"]>;
type Point = Caret["anchor"];

/** The quickest caret messages go out. */
const SEND_INTERVAL_MS = 50;
/** How often the viewer says they are still here, caret or not. */
const HEARTBEAT_MS = 5_000;
/** Someone who sends nothing for this long has left. */
const LAPSE_MS = 15_000;
const TEXT_PREFIX = 40;

interface Block {
  readonly pos: number;
  readonly node: Node;
}

const blockCache = new WeakMap<Node, ReadonlyArray<Block>>();

/** The document's text blocks in order, with where each starts. */
const blocksOf = (doc: Node): ReadonlyArray<Block> => {
  const cached = blockCache.get(doc);
  if (cached !== undefined) return cached;
  const blocks: Block[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    blocks.push({ pos, node });
    return false;
  });
  blockCache.set(doc, blocks);
  return blocks;
};

const prefix = (node: Node) => node.textContent.slice(0, TEXT_PREFIX);

/** A document position as a place others can find in their copy. */
const toPoint = (doc: Node, pos: number): Point | undefined => {
  const blocks = blocksOf(doc);
  // The last block starting before the position.
  let low = 0;
  let high = blocks.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((blocks[middle]?.pos ?? 0) < pos) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  const block = blocks[found];
  if (block === undefined || pos > block.pos + block.node.nodeSize - 1)
    return undefined;
  return {
    block: found,
    offset: pos - block.pos - 1,
    text: prefix(block.node),
  };
};

/** Where a place falls in this copy of the document. */
const fromPoint = (doc: Node, point: Point): number | undefined => {
  const blocks = blocksOf(doc);
  if (blocks.length === 0) return undefined;
  let block = blocks[point.block];
  if (block === undefined || prefix(block.node) !== point.text) {
    // The block with the same opening text nearest where it was.
    let best: Block | undefined;
    let distance = Number.POSITIVE_INFINITY;
    blocks.forEach((candidate, index) => {
      const gap = Math.abs(index - point.block);
      if (gap < distance && prefix(candidate.node) === point.text) {
        best = candidate;
        distance = gap;
      }
    });
    block = best ?? blocks[Math.min(point.block, blocks.length - 1)];
  }
  if (block === undefined) return undefined;
  return block.pos + 1 + Math.min(point.offset, block.node.content.size);
};

/** The viewer's selection as places, from text-block positions near it. */
const caretOf = (state: EditorState): Caret | undefined => {
  const { anchor, head } = state.selection;
  const near = (pos: number) =>
    toPoint(state.doc, pos) ??
    toPoint(state.doc, Selection.near(state.doc.resolve(pos)).head);
  const from = near(anchor);
  const to = near(head);
  return from === undefined || to === undefined
    ? undefined
    : { anchor: from, head: to };
};

interface Remote {
  readonly userId: string;
  readonly caret: Caret | undefined;
  readonly seenAt: number;
  /** Counts the caret's moves; a move shows the name tag again. */
  readonly moves: number;
}

/** The caret's mark: a bar in the person's color with their name above. */
const caretWidget = (person: CursorPerson, color: string) => () => {
  const caret = document.createElement("span");
  caret.className = "artifact-remote-caret";
  caret.style.setProperty("--artifact-remote", color);
  caret.setAttribute("aria-hidden", "true");
  if (person.name !== "") {
    const name = document.createElement("span");
    name.className = "artifact-remote-caret-name";
    name.textContent = person.name;
    caret.append(name);
  }
  return caret;
};

export class DocumentPresence {
  readonly #live: BoardLiveChannel;
  readonly #people: ArtifactPeople;
  readonly #remotes = new Map<string, Remote>();
  #view: EditorView | undefined;
  #focused = false;
  #sent = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastSend = 0;

  constructor(live: BoardLiveChannel, people: ArtifactPeople) {
    this.#live = live;
    this.#people = people;
  }

  /**
   * Starts with a mounted editor, following `edits` (the session's changes,
   * the viewer's or a newer revision's); returns how to stop.
   */
  attach(view: EditorView, edits: (listener: () => void) => () => void) {
    this.#view = view;
    const stopObserving = this.#live.observe(this.#receive);
    const stopPresent = this.#live.observePresent(this.#followPresent);
    const stopNames = this.#people.follow(this.redraw);
    const stopEdits = edits(this.sync);
    const heartbeat = setInterval(() => {
      this.#sent = "";
      this.sync();
      this.#lapse();
    }, HEARTBEAT_MS);
    // Others learn this person is here before they click.
    this.sync();
    return () => {
      clearInterval(heartbeat);
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      stopEdits();
      stopNames();
      stopObserving();
      stopPresent();
      // Closing it while staying on the Thread: the others' snapshot still
      // lists this connection, so say so.
      this.#live.send({ caret: null });
      this.#remotes.clear();
      this.#view = undefined;
    };
  }

  /** The viewer's caret counts once they have been in the editor. */
  focus() {
    this.#focused = true;
    this.sync();
  }

  /** The viewer's state may have changed: send it, at most every 50ms. */
  readonly sync = () => {
    if (this.#timer !== undefined || this.#view === undefined) return;
    const wait = Math.max(0, this.#lastSend + SEND_INTERVAL_MS - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#send();
    }, wait);
  };

  #send() {
    const view = this.#view;
    if (view === undefined) return;
    const caret = this.#focused ? caretOf(view.state) : undefined;
    const payload = caret === undefined ? {} : { caret };
    const key = JSON.stringify(payload);
    if (key === this.#sent) return;
    if (this.#live.send(payload)) {
      this.#sent = key;
      this.#lastSend = Date.now();
    }
  }

  /** Others on the document, in order of arrival. */
  users(): ReadonlyArray<string> {
    return [...this.#remotes.values()].map(({ userId }) => userId);
  }

  readonly #receive = (event: BoardLiveEvent) => {
    const { caret } = event.payload;
    const previous = this.#remotes.get(event.clientId);
    if (caret === null) this.#remotes.delete(event.clientId);
    else {
      const moved = JSON.stringify(caret) !== JSON.stringify(previous?.caret);
      this.#remotes.set(event.clientId, {
        userId: event.userId,
        caret,
        seenAt: Date.now(),
        moves: (previous?.moves ?? 0) + (moved ? 1 : 0),
      });
      // Someone new: answer, so they see this person too.
      if (previous === undefined) {
        this.#sent = "";
        this.sync();
      }
    }
    this.redraw();
  };

  /**
   * The hub's word on who has it open: a caret whose connection closed, or
   * whose tab was hidden or left, goes at once. Anyone who arrived or came
   * back hears this person's caret again.
   */
  readonly #followPresent = () => {
    const present = this.#live.present();
    if (present === undefined) return;
    let changed = false;
    for (const clientId of this.#remotes.keys())
      if (!present.has(clientId)) {
        this.#remotes.delete(clientId);
        changed = true;
      }
    this.#sent = "";
    this.sync();
    if (changed) this.redraw();
  };

  #lapse() {
    const now = Date.now();
    let changed = false;
    for (const [id, remote] of this.#remotes)
      if (now - remote.seenAt > LAPSE_MS) {
        this.#remotes.delete(id);
        changed = true;
      }
    if (changed) this.redraw();
  }

  #listeners = new Set<() => void>();

  /** Calls `listener` when who is here, or a name, changes. */
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #usersKey = "";
  #users: ReadonlyArray<string> = [];
  readonly getUsers = () => {
    const users = this.users();
    const key = users.join(",");
    if (key !== this.#usersKey) {
      this.#usersKey = key;
      this.#users = users;
    }
    return this.#users;
  };

  /** Draws the carets again: one arrived or left, or a name changed. */
  readonly redraw = () => {
    // Setting no props makes the view redraw its decorations.
    this.#view?.setProps({});
    for (const listener of this.#listeners) listener();
  };

  /** Everyone else's carets and selections in the document as it is now. */
  readonly decorations = (state: EditorState): Decoration[] => {
    const decorations: Decoration[] = [];
    for (const [clientId, { userId, caret, moves }] of this.#remotes) {
      if (caret === undefined) continue;
      const anchor = fromPoint(state.doc, caret.anchor);
      const head = fromPoint(state.doc, caret.head);
      if (anchor === undefined || head === undefined) continue;
      const color = collaboratorColor(userId).stroke;
      const person = this.#people.person(userId);
      if (anchor !== head)
        decorations.push(
          Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), {
            class: "artifact-remote-selection",
            style: `--artifact-remote: ${color}`,
          }),
        );
      decorations.push(
        Decoration.widget(head, caretWidget(person, color), {
          // A new key per move redraws the caret, which shows its name.
          key: `${clientId}:${person.name}:${moves}`,
          side: anchor > head ? -1 : 1,
          ignoreSelection: true,
        }),
      );
    }
    return decorations;
  };
}

/**
 * One mounted document editor's live carets: `presence` goes into the
 * editor's props and attaches to its view; `present` is who else has the
 * document open, for the header.
 */
export const useDocumentPresence = (
  threadId: ArtifactScope,
  initial: ArtifactDocument,
) => {
  const queryClient = useQueryClient();
  const { identity: viewer } = useAuthenticatedIdentity();
  const live = useBoardLiveChannel(threadId, initial.artifact.id);
  const [presence] = React.useState(
    () =>
      new DocumentPresence(
        live,
        new ArtifactPeople(queryClient, viewer, threadId),
      ),
  );
  const present = React.useSyncExternalStore(
    presence.subscribe,
    presence.getUsers,
    presence.getUsers,
  );
  return { presence, present };
};
