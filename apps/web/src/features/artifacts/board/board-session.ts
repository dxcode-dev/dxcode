import type { BoardLivePayload } from "@dx/api";
import {
  type BoardDocument,
  type BoardElement,
  type BoardFile,
  parseBoard,
  serializeBoard,
} from "@dx/domain";
import {
  CaptureUpdateAction,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { QueryClient } from "@tanstack/react-query";
import type {
  BoardLiveChannel,
  BoardLiveEvent,
} from "../../../shared/realtime/board-live.js";
import { acceptSavedArtifact } from "../artifact-document-queries.js";
import type { ArtifactScope } from "../artifact-scope.js";
import {
  type ArtifactDocument,
  type ArtifactsApi,
  artifactImageBlob,
  isArtifactConflict,
} from "../artifacts-api.js";
import { artifactKeys } from "../artifacts-queries.js";

/**
 * One open board: what the editor shows, what the server last saved, and
 * the live channel to everyone else on it.
 *
 * Saving: a change schedules a save of the whole scene after the gesture
 * ends, made from the revision the board last saw. A newer revision (a
 * conflict, or one arriving live) merges shape by shape into the scene with
 * the editor's own rule: the higher `version` of each element wins, and
 * `versionNonce` breaks a tie the same way everywhere, so two people's
 * changes to different shapes both stay and a board never shows a conflict.
 *
 * Live: while someone draws, the elements they change and their pointer go
 * to the others over the Thread's realtime socket, about 20 times a second,
 * and are never stored; the save that follows carries the same change.
 */

/** How long after the last change a save waits. */
const SAVE_DELAY_MS = 700;
/** The quickest live messages go out. */
const LIVE_INTERVAL_MS = 50;
/** A collaborator who sends nothing for this long leaves the board. */
const COLLABORATOR_LAPSE_MS = 30_000;
/** Deleted elements are kept this long so late merges see the delete. */
const TOMBSTONE_MS = 24 * 60 * 60 * 1000;
/** Live element batches stay well under the hub's message cap. */
const LIVE_MAX_CHARS = 200_000;

export type BoardSaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "unsaved" }
  | { readonly kind: "saving" }
  | { readonly kind: "error"; readonly message: string };

export interface BoardViewport {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: number;
}

export interface BoardPresence {
  readonly userId: string;
  readonly clientId: string;
}

export interface BoardSnapshot {
  readonly revision: number;
  readonly title: string;
  readonly folder: string;
  readonly save: BoardSaveState;
  readonly viewport: BoardViewport;
  /** Element ids selected now. */
  readonly selected: ReadonlyArray<string>;
  /** Live elements, for comment pins; replaced only when elements change. */
  readonly elements: ReadonlyArray<ExcalidrawElement>;
  readonly present: ReadonlyArray<BoardPresence>;
}

/**
 * A board on the default white canvas shows dx's own surface instead, so it
 * matches the app in light and dark; it is still stored, exported, and
 * previewed as white. A color someone picked shows as picked.
 */
const DEFAULT_BACKGROUND = "#ffffff";
export const shownBackground = (stored: string) =>
  stored.toLowerCase() === DEFAULT_BACKGROUND ? "transparent" : stored;
export const storedBackground = (shown: string) =>
  shown === "transparent" ? DEFAULT_BACKGROUND : shown;

/** Sum of every element's version: changes whenever any element does. */
const versionSum = (elements: ReadonlyArray<{ readonly version: number }>) => {
  let sum = 0;
  for (const element of elements) sum += element.version;
  return sum + elements.length * 1e-6;
};

const COLORS = [
  { background: "#ffc9c9", stroke: "#e03131" },
  { background: "#b2f2bb", stroke: "#2f9e44" },
  { background: "#a5d8ff", stroke: "#1971c2" },
  { background: "#ffec99", stroke: "#f08c00" },
  { background: "#d0bfff", stroke: "#7048e8" },
  { background: "#99e9f2", stroke: "#0c8599" },
  { background: "#fcc2d7", stroke: "#c2255c" },
];

/** A person's color, the same on every screen. */
export const collaboratorColor = (userId: string) => {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length] as (typeof COLORS)[number];
};

const isElement = (value: unknown): value is ExcalidrawElement =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { type?: unknown }).type === "string" &&
  Number.isSafeInteger((value as { version?: unknown }).version) &&
  Number.isSafeInteger((value as { versionNonce?: unknown }).versionNonce);

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const sameOrigin = (url: string) => {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
};

export class BoardSession {
  readonly #threadId: ArtifactScope;
  readonly #artifactId: string;
  readonly #api: ArtifactsApi;
  readonly #queryClient: QueryClient;
  readonly #readOnly: boolean;
  #live: BoardLiveChannel | undefined;
  #editor: ExcalidrawImperativeAPI | undefined;
  #board: BoardDocument;
  #revision: number;
  #title: string;
  #folder: string;
  /** Title or folder waiting for the next save. */
  #meta: { title?: string; folder?: string } = {};
  /** The version sum of the scene the server holds. */
  #syncedSum: number;
  /** The version sum of the scene as last seen. */
  #lastSum: number;
  /** Each element's version as last sent live or loaded. */
  readonly #sentVersions = new Map<string, number>();
  #pendingLive = new Map<string, ExcalidrawElement>();
  #pointer: BoardLivePayload["pointer"];
  #button: "up" | "down" = "up";
  #liveTimer: ReturnType<typeof setTimeout> | undefined;
  #lastLiveAt = 0;
  /** Retries of a live message the socket was not ready for. */
  #unsent = 0;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #saving: Promise<void> | undefined;
  #saveAgain = false;
  #retries = 0;
  /** Image files: uploaded (in the board) or uploading now. */
  readonly #uploading = new Set<string>();
  readonly #loadedFiles = new Set<string>();
  readonly #collaborators = new Map<
    string,
    Collaborator & { readonly userId: string; readonly seenAt: number }
  >();
  #lapseTimer: ReturnType<typeof setInterval> | undefined;
  #names: (userId: string) => { name: string; avatarUrl?: string } = () => ({
    name: "Someone",
  });
  #selectedKey = "";
  /**
   * Whether the person has pressed a key or a pointer on the board. Until
   * then, changes are the editor's own (it re-measures text once its fonts
   * load), so opening a board never saves or sends anything.
   */
  #interacted = false;
  #snapshot: BoardSnapshot;
  readonly #listeners = new Set<() => void>();

  constructor(options: {
    readonly threadId: ArtifactScope;
    readonly initial: ArtifactDocument;
    readonly api: ArtifactsApi;
    readonly queryClient: QueryClient;
    readonly readOnly: boolean;
  }) {
    this.#threadId = options.threadId;
    this.#artifactId = options.initial.artifact.id;
    this.#api = options.api;
    this.#queryClient = options.queryClient;
    this.#readOnly = options.readOnly;
    const parsed = parseBoard(options.initial.markdown);
    this.#board = parsed.ok ? parsed.board : parseBoardOrEmpty("");
    this.#revision = options.initial.artifact.revision;
    this.#title = options.initial.artifact.title;
    this.#folder = options.initial.artifact.folder;
    this.#syncedSum = versionSum(this.#board.elements);
    this.#lastSum = this.#syncedSum;
    for (const element of this.#board.elements)
      this.#sentVersions.set(element.id, element.version);
    this.#snapshot = {
      revision: this.#revision,
      title: this.#title,
      folder: this.#folder,
      save: { kind: "saved" },
      viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
      selected: [],
      elements: this.#board.elements.filter(
        (element) => !element.isDeleted,
      ) as unknown as ReadonlyArray<ExcalidrawElement>,
      present: [],
    };
  }

  // ------------------------------------------------------------- the store

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = () => this.#snapshot;

  #publish(next: Partial<BoardSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const listener of this.#listeners) listener();
  }

  get dirty() {
    return (
      this.#lastSum !== this.#syncedSum ||
      Object.keys(this.#meta).length > 0 ||
      this.#saving !== undefined
    );
  }

  get readOnly() {
    return this.#readOnly;
  }

  /** The scene the editor opens with. */
  initialData() {
    return {
      elements: restoreElements(
        this.#board.elements as unknown as ExcalidrawElement[],
        null,
        { refreshDimensions: false, repairBindings: true },
      ),
      appState: {
        viewBackgroundColor: shownBackground(this.#board.background),
        currentItemFontFamily: 5,
      },
      scrollToContent: true,
    };
  }

  /** A key, paste, or drop on the board: the person is editing. */
  readonly noteInput = () => {
    this.#interacted = true;
  };

  /** Names and pictures for collaborators' cursors. */
  setNames(names: (userId: string) => { name: string; avatarUrl?: string }) {
    this.#names = names;
  }

  // ---------------------------------------------------------- the editor

  #detach: (() => void) | undefined;

  /** The editor mounted: load its files and start the live channel. */
  attach(editor: ExcalidrawImperativeAPI, live: BoardLiveChannel) {
    this.detach();
    this.#detach = this.#attach(editor, live);
  }

  /** The editor unmounted: stop the live channel and save what is left. */
  detach() {
    this.#detach?.();
    this.#detach = undefined;
  }

  #attach(editor: ExcalidrawImperativeAPI, live: BoardLiveChannel) {
    this.#editor = editor;
    this.#live = live;
    // Elements the editor restored may differ from the stored ones in
    // version (it repairs bindings and indices); that is the scene now.
    const elements = editor.getSceneElementsIncludingDeleted();
    this.#lastSum = versionSum(elements);
    this.#syncedSum = this.#lastSum;
    for (const element of elements)
      this.#sentVersions.set(element.id, element.version);
    void this.#loadFiles(this.#board.files);
    const stopLive = live.observe(this.#receiveLive);
    this.#lapseTimer = setInterval(this.#lapse, 5_000);
    // Others on the board learn this person is here, before they move.
    this.#scheduleLive();
    return () => {
      stopLive();
      if (this.#lapseTimer !== undefined) clearInterval(this.#lapseTimer);
      this.#lapseTimer = undefined;
      // Others stop seeing this pointer at once.
      this.#live?.send({ pointer: null, selected: [] });
      if (this.dirty) void this.#save();
      this.#editor = undefined;
      this.#live = undefined;
    };
  }

  /** Every change the editor makes: elements, selection, scroll. */
  readonly onChange = (
    elements: ReadonlyArray<OrderedExcalidrawElement>,
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const sum = versionSum(elements);
    const changes: { -readonly [K in keyof BoardSnapshot]?: BoardSnapshot[K] } =
      {};
    if (sum !== this.#lastSum && !this.#interacted) {
      // The editor's own adjustment: what the server holds, as shown here.
      this.#syncedSum += sum - this.#lastSum;
      this.#lastSum = sum;
      for (const element of elements)
        this.#sentVersions.set(element.id, element.version);
      changes.elements = elements.filter((element) => !element.isDeleted);
    } else if (sum !== this.#lastSum) {
      this.#lastSum = sum;
      for (const element of elements)
        if (this.#sentVersions.get(element.id) !== element.version) {
          this.#pendingLive.set(element.id, element);
          this.#sentVersions.set(element.id, element.version);
        }
      if (this.#pendingLive.size > 0) this.#scheduleLive();
      changes.elements = elements.filter((element) => !element.isDeleted);
      if (!this.#readOnly && sum !== this.#syncedSum) {
        changes.save = { kind: "unsaved" };
        this.#scheduleSave();
      }
    }
    const selected = Object.keys(appState.selectedElementIds).filter(
      (id) => appState.selectedElementIds[id],
    );
    const selectedKey = selected.join(",");
    if (selectedKey !== this.#selectedKey) {
      this.#selectedKey = selectedKey;
      changes.selected = selected;
      this.#scheduleLive();
    }
    const viewport = {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
    };
    const shown = this.#snapshot.viewport;
    if (
      viewport.scrollX !== shown.scrollX ||
      viewport.scrollY !== shown.scrollY ||
      viewport.zoom !== shown.zoom
    )
      changes.viewport = viewport;
    if (!this.#readOnly) this.#uploadFiles(files);
    if (Object.keys(changes).length > 0) this.#publish(changes);
  };

  /** The pointer moved or a button changed. */
  readonly onPointerUpdate = (payload: {
    readonly pointer: { x: number; y: number; tool: "pointer" | "laser" };
    readonly button: "down" | "up";
  }) => {
    const released = this.#button === "down" && payload.button === "up";
    if (payload.button === "down") this.#interacted = true;
    this.#pointer = payload.pointer;
    this.#button = payload.button;
    this.#scheduleLive();
    // A gesture just ended: a pending save may go now.
    if (released && this.#lastSum !== this.#syncedSum) this.#scheduleSave();
  };

  // ------------------------------------------------------------------ live

  #scheduleLive() {
    if (this.#liveTimer !== undefined || this.#live === undefined) return;
    const wait = Math.max(
      0,
      LIVE_INTERVAL_MS - (Date.now() - this.#lastLiveAt),
    );
    this.#liveTimer = setTimeout(this.#flushLive, wait);
  }

  readonly #flushLive = () => {
    this.#liveTimer = undefined;
    this.#lastLiveAt = Date.now();
    const elements = [...this.#pendingLive.values()];
    this.#pendingLive = new Map();
    const selected =
      this.#selectedKey === "" ? [] : this.#selectedKey.split(",");
    const base: BoardLivePayload = {
      ...(this.#pointer === undefined ? {} : { pointer: this.#pointer }),
      button: this.#button,
      selected: selected.slice(0, 500),
    };
    if (this.#readOnly || elements.length === 0) {
      // The socket may not have joined the Thread yet: try again shortly,
      // so others see this person without waiting for them to move.
      if (this.#live?.send(base) === false && this.#unsent < 10) {
        this.#unsent += 1;
        setTimeout(() => this.#scheduleLive(), 1_000);
      } else this.#unsent = 0;
      return;
    }
    // Big batches (a long freehand stroke, a paste) go in parts; anything
    // still too big waits for the save.
    let batch: ExcalidrawElement[] = [];
    let size = 0;
    for (const element of elements) {
      const length = JSON.stringify(element).length;
      if (length > LIVE_MAX_CHARS) continue;
      if (size + length > LIVE_MAX_CHARS || batch.length >= 1000) {
        this.#live?.send({ ...base, elements: batch });
        batch = [];
        size = 0;
      }
      batch.push(element);
      size += length;
    }
    this.#live?.send({ ...base, elements: batch });
  };

  readonly #receiveLive = (event: BoardLiveEvent) => {
    const editor = this.#editor;
    if (editor === undefined) return;
    const { payload } = event;
    const previous = this.#collaborators.get(event.clientId);
    // Someone new: answer once, so they see this person too.
    if (previous === undefined && event.payload.pointer !== null)
      this.#scheduleLive();
    const person = this.#names(event.userId);
    const color = collaboratorColor(event.userId);
    const left = payload.pointer === null;
    if (left) this.#collaborators.delete(event.clientId);
    else
      this.#collaborators.set(event.clientId, {
        userId: event.userId,
        seenAt: Date.now(),
        username: person.name,
        ...(person.avatarUrl === undefined
          ? {}
          : { avatarUrl: person.avatarUrl }),
        color,
        id: event.userId,
        socketId: event.clientId as SocketId,
        pointer:
          payload.pointer === undefined || payload.pointer === null
            ? previous?.pointer
            : { ...payload.pointer, tool: payload.pointer.tool ?? "pointer" },
        button: payload.button ?? previous?.button ?? "up",
        selectedElementIds: Object.fromEntries(
          (payload.selected ?? []).map((id) => [id, true as const]),
        ),
      });
    const elements = (payload.elements ?? []).filter(isElement);
    if (elements.length > 0) this.#merge(elements);
    editor.updateScene({
      collaborators: new Map(
        [...this.#collaborators].map(([id, collaborator]) => [
          id as SocketId,
          collaborator,
        ]),
      ),
    });
    this.#publishPresence();
  };

  /** Someone else's elements, merged in; not this person's to save. */
  #merge(remote: ReadonlyArray<ExcalidrawElement>, synced?: number) {
    const editor = this.#editor;
    if (editor === undefined) return;
    const local = editor.getSceneElementsIncludingDeleted();
    const before = versionSum(local);
    const merged = reconcileElements(
      local,
      restoreElements(remote, local, { refreshDimensions: false }) as never,
      editor.getAppState(),
    ) as unknown as OrderedExcalidrawElement[];
    const after = versionSum(merged);
    for (const element of remote)
      this.#sentVersions.set(
        element.id,
        Math.max(element.version, this.#sentVersions.get(element.id) ?? 0),
      );
    // A live change does not make this scene unsaved; a saved revision
    // says what the server holds.
    this.#syncedSum =
      synced === undefined ? this.#syncedSum + (after - before) : synced;
    this.#lastSum = after;
    editor.updateScene({
      elements: merged,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.#publish({
      elements: merged.filter((element) => !element.isDeleted),
      ...(this.#lastSum === this.#syncedSum && this.#saving === undefined
        ? { save: { kind: "saved" } }
        : {}),
    });
  }

  readonly #lapse = () => {
    const now = Date.now();
    let changed = false;
    for (const [id, collaborator] of this.#collaborators)
      if (now - collaborator.seenAt > COLLABORATOR_LAPSE_MS) {
        this.#collaborators.delete(id);
        changed = true;
      }
    if (!changed) return;
    this.#editor?.updateScene({
      collaborators: new Map(
        [...this.#collaborators].map(([id, collaborator]) => [
          id as SocketId,
          collaborator,
        ]),
      ),
    });
    this.#publishPresence();
  };

  #publishPresence() {
    const present = [...this.#collaborators].map(([clientId, { userId }]) => ({
      userId,
      clientId,
    }));
    const key = (list: ReadonlyArray<BoardPresence>) =>
      list.map(({ clientId }) => clientId).join(",");
    if (key(present) !== key(this.#snapshot.present))
      this.#publish({ present });
  }

  // -------------------------------------------------------------- revisions

  /** A revision read from the server: newer ones merge into the scene. */
  receive(document: ArtifactDocument) {
    if (document.artifact.revision <= this.#revision) return;
    const parsed = parseBoard(document.markdown);
    if (!parsed.ok) return;
    this.#revision = document.artifact.revision;
    this.#board = parsed.board;
    if (this.#meta.title === undefined) this.#title = document.artifact.title;
    if (this.#meta.folder === undefined)
      this.#folder = document.artifact.folder;
    this.#publish({
      revision: this.#revision,
      title: this.#title,
      folder: this.#folder,
    });
    void this.#loadFiles(parsed.board.files);
    if (this.#editor === undefined) {
      this.#syncedSum = versionSum(parsed.board.elements);
      this.#lastSum = this.#syncedSum;
      return;
    }
    this.#merge(
      parsed.board.elements as unknown as ReadonlyArray<ExcalidrawElement>,
      versionSum(parsed.board.elements),
    );
    if (this.#lastSum !== this.#syncedSum && !this.#readOnly) {
      this.#publish({ save: { kind: "unsaved" } });
      this.#scheduleSave();
    }
    if (
      shownBackground(parsed.board.background) !==
      this.#editor.getAppState().viewBackgroundColor
    )
      this.#editor.updateScene({
        appState: {
          viewBackgroundColor: shownBackground(parsed.board.background),
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
  }

  /** Follows the artifact's query, so saves others make arrive. */
  followQuery() {
    const key = JSON.stringify(
      artifactKeys.detail(this.#threadId, this.#artifactId),
    );
    return this.#queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        JSON.stringify(event.query.queryKey) !== key
      )
        return;
      const data = event.query.state.data as ArtifactDocument | undefined;
      if (data?.artifact?.id === this.#artifactId) this.receive(data);
    });
  }

  // ----------------------------------------------------------------- saves

  #scheduleSave() {
    if (this.#readOnly) return;
    if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      // Never in the middle of a drag: the gesture's end schedules again.
      if (this.#button === "down") return;
      void this.#save();
    }, SAVE_DELAY_MS);
  }

  /** Saves now, as Cmd+S and leaving the page do. */
  flush() {
    if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    if (this.dirty) void this.#save();
  }

  rename(title: string) {
    const next = title.replace(/\s+/g, " ").trim();
    if (next === "" || next === this.#title) return;
    this.#title = next;
    this.#meta = { ...this.#meta, title: next };
    this.#publish({ title: next });
    void this.#save();
  }

  moveTo(folder: string) {
    const next = folder.replace(/\s+/g, " ").trim();
    if (next === this.#folder) return;
    this.#folder = next;
    this.#meta = { ...this.#meta, folder: next };
    this.#publish({ folder: next });
    void this.#save();
  }

  /** The scene as stored: no view state, old deletions dropped. */
  #body(elements: ReadonlyArray<ExcalidrawElement>) {
    const now = Date.now();
    const kept = elements.filter(
      (element) =>
        !element.isDeleted || now - (element.updated ?? now) < TOMBSTONE_MS,
    );
    const used = new Set(
      kept.flatMap((element) =>
        element.type === "image" && !element.isDeleted && element.fileId
          ? [element.fileId as string]
          : [],
      ),
    );
    const files: Record<string, BoardFile> = {};
    for (const [id, file] of Object.entries(this.#board.files))
      if (used.has(id)) files[id] = file;
    return serializeBoard({
      ...this.#board,
      elements: kept as unknown as ReadonlyArray<BoardElement>,
      files,
      background: storedBackground(
        this.#editor?.getAppState().viewBackgroundColor ??
          this.#board.background,
      ),
    });
  }

  #save(): Promise<void> {
    if (this.#readOnly || this.#editor === undefined) return Promise.resolve();
    if (this.#saving !== undefined) {
      this.#saveAgain = true;
      return this.#saving;
    }
    const run = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const editor = this.#editor;
        if (editor === undefined) return;
        const elements = editor.getSceneElementsIncludingDeleted();
        const sum = versionSum(elements);
        const meta = this.#meta;
        if (sum === this.#syncedSum && Object.keys(meta).length === 0) {
          this.#publish({ save: { kind: "saved" } });
          return;
        }
        this.#publish({ save: { kind: "saving" } });
        try {
          const saved = await this.#api.save(this.#threadId, this.#artifactId, {
            baseRevision: this.#revision,
            markdown: this.#body(elements),
            ...meta,
          });
          this.#meta = {};
          this.#retries = 0;
          const parsed = parseBoard(saved.markdown);
          if (parsed.ok) this.#board = parsed.board;
          this.#revision = saved.artifact.revision;
          this.#syncedSum = sum;
          acceptSavedArtifact(this.#queryClient, this.#threadId, saved);
          this.#publish({
            revision: this.#revision,
            save:
              this.#lastSum === this.#syncedSum
                ? { kind: "saved" }
                : { kind: "unsaved" },
          });
          return;
        } catch (error) {
          if (isArtifactConflict(error)) {
            // Someone saved first: take their shapes in, then save ours.
            this.receive(error.current);
            continue;
          }
          this.#retries += 1;
          this.#publish({
            save: {
              kind: "error",
              message:
                error instanceof Error ? error.message : "Couldn't save.",
            },
          });
          setTimeout(
            () => this.#scheduleSave(),
            Math.min(30_000, 1_000 * 2 ** this.#retries),
          );
          return;
        }
      }
    };
    this.#saving = run().finally(() => {
      this.#saving = undefined;
      if (this.#saveAgain) {
        this.#saveAgain = false;
        void this.#save();
      } else if (this.#lastSum !== this.#syncedSum) this.#scheduleSave();
    });
    return this.#saving;
  }

  // ----------------------------------------------------------------- files

  /** Pasted or dropped images go to the Thread's storage, not the board. */
  #uploadFiles(files: BinaryFiles) {
    for (const [id, file] of Object.entries(files)) {
      if (
        this.#board.files[id] !== undefined ||
        this.#uploading.has(id) ||
        !file.dataURL.startsWith("data:")
      )
        continue;
      this.#uploading.add(id);
      this.#loadedFiles.add(id);
      void (async () => {
        try {
          const blob = await artifactImageBlob(file.dataURL);
          if (blob === undefined) throw new Error("Unreadable image.");
          const extension = file.mimeType.split("/")[1] ?? "png";
          const stored = await this.#api.uploadImage(
            this.#threadId,
            new File([blob], `board-image.${extension}`, {
              type: file.mimeType,
            }),
            () => undefined,
          );
          this.#board = {
            ...this.#board,
            files: {
              ...this.#board.files,
              [id]: { mimeType: file.mimeType, url: stored.url },
            },
          };
          this.#meta = { ...this.#meta };
          // The file's address is part of the board: save it.
          this.#syncedSum = Number.NaN;
          this.#scheduleSave();
        } catch {
          this.#uploading.delete(id);
          this.#loadedFiles.delete(id);
        }
      })();
    }
  }

  async #loadFiles(files: Readonly<Record<string, BoardFile>>) {
    const editor = this.#editor;
    if (editor === undefined) return;
    const missing = Object.entries(files).filter(
      ([id, file]) => !this.#loadedFiles.has(id) && sameOrigin(file.url),
    );
    if (missing.length === 0) return;
    for (const [id] of missing) this.#loadedFiles.add(id);
    const loaded = await Promise.all(
      missing.map(async ([id, file]) => {
        try {
          const blob = await artifactImageBlob(file.url);
          if (blob === undefined) throw new Error("Image unavailable.");
          return {
            id,
            mimeType: file.mimeType,
            dataURL: await toDataUrl(blob),
            created: Date.now(),
          } as unknown as BinaryFileData;
        } catch {
          this.#loadedFiles.delete(id);
          return undefined;
        }
      }),
    );
    const ready = loaded.filter((file) => file !== undefined);
    if (ready.length > 0) this.#editor?.addFiles(ready);
  }
}

const parseBoardOrEmpty = (body: string) => {
  const parsed = parseBoard(body);
  if (parsed.ok) return parsed.board;
  throw new Error(parsed.message);
};
