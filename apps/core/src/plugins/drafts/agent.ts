import type { Bindings } from "../../http/types.js";
import type { ResolvedCodePlugin } from "../worker-host/resolve.js";
import type { StoredDraft } from "./store.js";

/**
 * A Thread's draft plugins as its agent sees them, between tool calls.
 *
 * The agent function renders synchronously before every model call, so the
 * drafts live here, in the agent's isolate: each submission starts by
 * asking the Thread execution object for them, and so does every tool call
 * that can load, reload, or unload one (a shell command, `manage_dx`,
 * `plugin_tool`). That question names the revision already held, and the
 * answer carries the drafts only when they changed: one call to the
 * Thread's own object, never a D1 read.
 */

interface Held {
  readonly revision: number;
  readonly drafts: ReadonlyArray<StoredDraft>;
}

const held = new Map<string, Held>();

type DraftObject = {
  pluginDrafts(
    threadId: string,
    known?: number,
  ): Promise<{
    readonly revision: number;
    readonly drafts?: ReadonlyArray<StoredDraft>;
  }>;
  unloadPluginDraft(threadId: string, name: string): Promise<boolean>;
};

const objectOf = (bindings: Bindings, threadId: string) => {
  const namespace = bindings.THREAD_EXECUTION;
  return namespace === undefined
    ? undefined
    : (namespace.get(namespace.idFromName(threadId)) as unknown as DraftObject);
};

/**
 * Asks the Thread's execution object whether its drafts changed since the
 * revision held, and keeps the answer. A failed question keeps what was
 * held: a draft never appears or vanishes because a call failed.
 */
export const refreshThreadDrafts = async (
  bindings: Bindings,
  threadId: string,
): Promise<void> => {
  const object = objectOf(bindings, threadId);
  if (object === undefined) return;
  const known = held.get(threadId);
  try {
    const answer = await object.pluginDrafts(threadId, known?.revision);
    if (answer.drafts !== undefined)
      held.set(threadId, {
        revision: answer.revision,
        drafts: answer.drafts,
      });
  } catch {
    // Keep what was held.
  }
};

/** Unloads the draft of a plugin that was just kept. */
export const unloadThreadDraft = async (
  bindings: Bindings,
  threadId: string,
  name: string,
): Promise<boolean> => {
  const object = objectOf(bindings, threadId);
  if (object === undefined) return false;
  const removed = await object.unloadPluginDraft(threadId, name);
  await refreshThreadDrafts(bindings, threadId);
  return removed;
};

/** Every draft the Thread holds, whoever's turn it is. */
export const heldThreadDrafts = (threadId: string) =>
  held.get(threadId)?.drafts ?? [];

/**
 * The drafts that act in this turn: all of them. Anyone who can write in
 * the Thread uses its drafts as the owner does.
 */
export const threadDrafts = (
  threadId: string,
): ReadonlyArray<ResolvedCodePlugin> =>
  heldThreadDrafts(threadId).map(({ plugin }) => plugin);

/**
 * The Thread's plugins with its drafts first: a draft runs before installed
 * plugins (its `tool.call` gate too, so an installed gate decides last),
 * and a draft of an installed plugin replaces it in this Thread.
 */
export const withThreadDrafts = (
  drafts: ReadonlyArray<ResolvedCodePlugin>,
  installed: ReadonlyArray<ResolvedCodePlugin>,
): ReadonlyArray<ResolvedCodePlugin> => {
  if (drafts.length === 0) return installed;
  const names = new Set(drafts.map(({ name }) => name));
  return [...drafts, ...installed.filter(({ name }) => !names.has(name))];
};

/**
 * Installed plugins `manage_dx` changed in a Thread during the current
 * submission, by name: the agent resolves its installed plugins again
 * before its next tool call, and a draft of the same name is unloaded.
 */
const installedChanges = new Map<string, Set<string>>();

export const noteInstalledPluginChange = (threadId: string, name: string) => {
  const names = installedChanges.get(threadId) ?? new Set<string>();
  names.add(name);
  installedChanges.set(threadId, names);
};

export const takeInstalledPluginChanges = (
  threadId: string,
): ReadonlyArray<string> => {
  const names = installedChanges.get(threadId);
  installedChanges.delete(threadId);
  return names === undefined ? [] : [...names];
};
