import type { PluginDataViewOption } from "@dx/api";
import type { Bindings } from "../../http/types.js";
import { pushViewState, type SetViewStateResult } from "../views/state.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import { heldThreadDrafts, refreshThreadDrafts } from "./agent.js";
import type {
  DraftViewState,
  SetDraftViewStateResult,
  StoredDraft,
} from "./store.js";

/**
 * A draft plugin's views described as data, in the Thread that loaded it.
 * They draw only as a panel there, for anyone who can open that Thread; the
 * files and state stay in the Thread's execution object with the draft, so
 * nothing about a draft reaches D1. A set tells watching browsers as an
 * install's does, on the owner's realtime hub.
 */

/** A draft's install id: `draftInstallId` in `orb.ts`. */
export const isDraftInstallId = (id: string) => id.startsWith("plg_draft-");

type DraftViewObject = {
  draftViewFile(
    threadId: string,
    name: string,
    integrity: string,
  ): Promise<string | undefined>;
  draftViewState(
    threadId: string,
    name: string,
    viewId: string,
  ): Promise<DraftViewState | undefined>;
  setDraftViewState(
    threadId: string,
    name: string,
    viewId: string,
    path: string,
    value: unknown,
  ): Promise<SetDraftViewStateResult>;
};

const objectOf = (bindings: Bindings, threadId: string) => {
  const namespace = bindings.THREAD_EXECUTION;
  return namespace === undefined
    ? undefined
    : (namespace.get(
        namespace.idFromName(threadId),
      ) as unknown as DraftViewObject);
};

/** The Thread's drafts, asked of its object when they changed. */
export const threadDrafts = async (
  bindings: Bindings,
  threadId: string,
): Promise<ReadonlyArray<StoredDraft>> => {
  await refreshThreadDrafts(bindings, threadId);
  return heldThreadDrafts(threadId);
};

/** The Thread panels its drafts' views offer, named "X (draft)". */
export const draftViewOptions = (
  drafts: ReadonlyArray<StoredDraft>,
): ReadonlyArray<PluginDataViewOption> =>
  drafts.flatMap(({ plugin }) =>
    (plugin.code.dataViews ?? []).map((view) => ({
      plugin: plugin.name,
      view: view.id,
      title: view.title,
      pluginTitle: plugin.displayName,
      ...(view.icon === undefined ? {} : { icon: view.icon }),
      show: ["panel" as const],
      installId: plugin.pluginId,
      integrity: view.integrity,
    })),
  );

export const draftViewFile = (
  bindings: Bindings,
  threadId: string,
  name: string,
  integrity: string,
) =>
  objectOf(bindings, threadId)?.draftViewFile(threadId, name, integrity) ??
  Promise.resolve(undefined);

export const readDraftViewState = (
  bindings: Bindings,
  threadId: string,
  name: string,
  viewId: string,
) =>
  objectOf(bindings, threadId)?.draftViewState(threadId, name, viewId) ??
  Promise.resolve(undefined);

/** `ctx.views.set` from a draft's code, or a view call's `result`. */
export const setDraftViewState = async (
  bindings: Bindings,
  input: {
    readonly install: Pick<
      PluginInstallRecord,
      "pluginId" | "name" | "targetId" | "installedByUserId" | "draft"
    >;
    readonly viewId: string;
    readonly path: string;
    readonly value: unknown;
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<SetViewStateResult> => {
  const threadId = input.install.draft?.threadId;
  const object =
    threadId === undefined ? undefined : objectOf(bindings, threadId);
  if (threadId === undefined || object === undefined)
    return {
      ok: false,
      code: "busy",
      message: "This draft's Thread is not reachable.",
    };
  let value: unknown;
  try {
    const text = JSON.stringify(input.value);
    value = text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return {
      ok: false,
      code: "bad-value",
      message:
        "The value must be JSON: text, numbers, true or false, null, lists, and objects.",
    };
  }
  const result = await object.setDraftViewState(
    threadId,
    input.install.name,
    input.viewId,
    input.path,
    value,
  );
  if (!result.ok) return result;
  const push = pushViewState(
    bindings,
    {
      pluginId: input.install.pluginId,
      scope: "personal",
      targetId: input.install.targetId,
      installedByUserId: input.install.installedByUserId,
    },
    input.viewId,
    { version: result.version, path: input.path, value },
  );
  if (input.waitUntil === undefined) await push;
  else input.waitUntil(push);
  return { ok: true, version: result.version };
};
