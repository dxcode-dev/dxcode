import {
  MAX_DATA_VIEW_STATE_BYTES,
  parseStatePath,
  writeStatePath,
} from "@dx/domain";
import type { ResolvedCodePlugin } from "../worker-host/resolve.js";

/**
 * The draft plugins one Thread loaded, kept by its Thread execution object
 * (the object `dxd` already talks to), never in D1. `revision` counts every
 * load, reload, and unload, so the agent asks "anything since revision n?"
 * between tool calls and reads nothing more when the answer is no.
 */

/** At most this many drafts are loaded in one Thread at once. */
export const MAX_DRAFTS_PER_THREAD = 8;

export interface StoredDraft {
  /** What the agent resolves: a personal-scope install with `draft` set. */
  readonly plugin: ResolvedCodePlugin & {
    readonly draft: NonNullable<ResolvedCodePlugin["draft"]>;
  };
  /** The Thread's owner when it was loaded; it runs as their install. */
  readonly ownerUserId: string;
  readonly loadedAt: string;
  /** How many times it was loaded: 1, then one more per reload. */
  readonly loads: number;
  /** The manifest's notes on what dx left out, shown on load. */
  readonly skipped: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
  }>;
}

export interface DraftState {
  readonly revision: number;
  readonly drafts: ReadonlyArray<StoredDraft>;
}

const KEY = "plugin-drafts";

// A draft's views: each file's text and each view's state under keys of
// their own, so the drafts' own value stays small (a state is up to
// 512 KB). Unloading clears them; a reload replaces the files and keeps
// the state.
const fileKey = (name: string, integrity: string) =>
  `plugin-draft-view-file:${name}:${integrity}`;
const stateKey = (name: string, viewId: string) =>
  `plugin-draft-view-state:${name}:${viewId}`;

export interface DraftViewState {
  readonly state: unknown;
  readonly version: number;
}

export type SetDraftViewStateResult =
  | { readonly ok: true; readonly version: number }
  | {
      readonly ok: false;
      readonly code: "unknown-view" | "bad-path" | "too-large";
      readonly message: string;
    };

const encoder = new TextEncoder();

/** One Thread's drafts in its execution object's storage. */
export class DraftStore {
  readonly #storage: DurableObjectStorage;
  #state: DraftState | undefined;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async read(): Promise<DraftState> {
    this.#state ??= ((await this.#storage.get<DraftState>(KEY)) ?? {
      revision: 0,
      drafts: [],
    }) satisfies DraftState;
    return this.#state;
  }

  /** Replaces the drafts and counts one revision. */
  async write(drafts: ReadonlyArray<StoredDraft>): Promise<DraftState> {
    const current = await this.read();
    const next: DraftState = { revision: current.revision + 1, drafts };
    await this.#storage.put(KEY, next);
    this.#state = next;
    return next;
  }

  /** Removes the draft named `name`, and its views; false when none was loaded. */
  async remove(name: string): Promise<boolean> {
    const { drafts } = await this.read();
    const kept = drafts.filter(({ plugin }) => plugin.name !== name);
    if (kept.length === drafts.length) return false;
    await this.write(kept);
    await this.#clear(`plugin-draft-view-file:${name}:`);
    await this.#clear(`plugin-draft-view-state:${name}:`);
    return true;
  }

  async #clear(prefix: string) {
    const keys = [...(await this.#storage.list({ prefix })).keys()];
    for (let at = 0; at < keys.length; at += 128)
      await this.#storage.delete(keys.slice(at, at + 128));
  }

  /** Replaces a draft's view files with the ones it loaded now. */
  async putViewFiles(
    name: string,
    files: ReadonlyArray<{
      readonly integrity: string;
      readonly content: string;
    }>,
  ) {
    await this.#clear(`plugin-draft-view-file:${name}:`);
    for (const file of files)
      await this.#storage.put(fileKey(name, file.integrity), file.content);
  }

  async viewFile(name: string, integrity: string): Promise<string | undefined> {
    return this.#storage.get<string>(fileKey(name, integrity));
  }

  async viewState(
    name: string,
    viewId: string,
  ): Promise<DraftViewState | undefined> {
    return this.#storage.get<DraftViewState>(stateKey(name, viewId));
  }

  /**
   * Sets the value at `path` in a draft view's state, as `ctx.views.set`
   * does for an install: the view must be one the draft declares, the path
   * well formed, and the state at most 512 KB. This object runs one call at
   * a time, so the read and write need no version check.
   */
  async setViewState(
    name: string,
    viewId: string,
    path: string,
    value: unknown,
  ): Promise<SetDraftViewStateResult> {
    const { drafts } = await this.read();
    const draft = drafts.find(({ plugin }) => plugin.name === name);
    const view = draft?.plugin.code.dataViews?.find(({ id }) => id === viewId);
    if (draft === undefined || view === undefined)
      return {
        ok: false,
        code: "unknown-view",
        message: `${name} has no view ${JSON.stringify(viewId)}. Its views: ${(draft?.plugin.code.dataViews ?? []).map(({ id }) => id).join(", ") || "none"}; declare each in the manifest's views.`,
      };
    const segments = parseStatePath(path);
    if (segments === undefined)
      return {
        ok: false,
        code: "bad-path",
        message: `The path ${JSON.stringify(path)} is not a state path. Use keys and list indexes joined by dots, such as stats.errors or rows.0.status, or "" for the whole state.`,
      };
    const current = await this.viewState(name, viewId);
    let base = current?.state;
    if (current === undefined) {
      // A view starts from its file's own `state`.
      const text = await this.viewFile(name, view.integrity);
      try {
        base = (JSON.parse(text ?? "{}") as { state?: unknown }).state ?? {};
      } catch {
        base = {};
      }
    }
    const written = writeStatePath(base, segments, value);
    if (!written.ok)
      return {
        ok: false,
        code: "bad-path",
        message: `Cannot set ${path}: ${written.reason}.`,
      };
    const json = JSON.stringify(written.state ?? {});
    const bytes = encoder.encode(json).byteLength;
    if (bytes > MAX_DATA_VIEW_STATE_BYTES)
      return {
        ok: false,
        code: "too-large",
        message: `The view ${viewId}'s state would be ${bytes.toLocaleString("en-US")} bytes; a view's state is at most ${MAX_DATA_VIEW_STATE_BYTES.toLocaleString("en-US")}. Keep fewer rows or shorter values.`,
      };
    const version = (current?.version ?? 0) + 1;
    await this.#storage.put(stateKey(name, viewId), {
      state: JSON.parse(json) as unknown,
      version,
    } satisfies DraftViewState);
    return { ok: true, version };
  }
}
