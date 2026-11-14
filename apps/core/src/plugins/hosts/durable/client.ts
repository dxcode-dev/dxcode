import type { PluginJob } from "@dx/domain";
import type { Bindings } from "../../../http/types.js";
import type {
  PluginHostDependencies,
  PluginInstallRecord,
} from "../../worker-host/host.js";
import type { PluginTier } from "../tier.js";
import { callTierOf as callTier } from "../tier.js";
import type { PluginDurableHostObject } from "./object.js";

/**
 * How dx reaches an install's Durable Object: one object per install, or per
 * install and Thread when the manifest says `durableScope: "thread"`. Every
 * call carries the install's {@link DurableMeta}, so the object never reads
 * D1 to learn who it serves; it records the newest version it was told.
 */

/** What the object needs to run the install's code and bill it. */
export interface DurableMeta {
  readonly installId: string;
  readonly pluginName: string;
  readonly displayName: string;
  readonly scope: PluginInstallRecord["scope"];
  readonly targetId: string;
  readonly version: string;
  readonly integrity: string;
  readonly ownerUserId: string;
  /** The Thread a thread-scoped object serves. */
  readonly threadId?: string;
  readonly tier: PluginTier;
  readonly workspaceId: string;
  readonly jobs: ReadonlyArray<PluginJob>;
  /** The manifest's scope: a thread-scoped install's install-wide object runs no jobs. */
  readonly durableScope: "install" | "thread";
}

/** The capabilities `ctx.sql`, `ctx.blobs`, `ctx.jobs`, and `ctx.watch` reach. */
export interface PluginDurableCapabilities {
  sqlExec(
    meta: DurableMeta,
    statement: string,
    params: ReadonlyArray<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>>; changes: number }>;
  blobPut(
    meta: DurableMeta,
    key: string,
    body: ArrayBuffer | string,
    contentType: string | undefined,
  ): Promise<void>;
  blobGet(
    meta: DurableMeta,
    key: string,
  ): Promise<{ body: ArrayBuffer; contentType?: string } | undefined>;
  blobDelete(meta: DurableMeta, key: string): Promise<void>;
  blobList(meta: DurableMeta, prefix: string): Promise<Array<string>>;
  jobsSchedule(
    meta: DurableMeta,
    id: string,
    when: { at?: number; every?: string; cron?: string },
    data: unknown,
  ): Promise<void>;
  jobsCancel(meta: DurableMeta, id: string): Promise<void>;
  jobsList(meta: DurableMeta): Promise<Array<{ id: string; next?: number }>>;
  watchOpen(
    meta: DurableMeta,
    target: string,
    opener: DurableOpener,
  ): Promise<void>;
  watchClose(meta: DurableMeta, target: string): Promise<void>;
}

/** What opened a watch, re-run when its handler is gone from the isolate. */
export type DurableOpener =
  | { readonly kind: "job"; readonly id: string; readonly data: unknown }
  | { readonly kind: "host-call"; readonly fn: string; readonly args: unknown };

export const durableNamespace = (bindings: Bindings) =>
  bindings.PLUGIN_DURABLE_HOST as
    | DurableObjectNamespace<PluginDurableHostObject>
    | undefined;

/** The object's name: the install, plus the Thread for thread scope. */
export const durableObjectName = (
  installId: string,
  threadId: string | undefined,
) => (threadId === undefined ? installId : `${installId}/${threadId}`);

export const durableMetaOf = (
  dependencies: PluginHostDependencies,
): DurableMeta => {
  const { install } = dependencies;
  const threadScoped = install.code.durableScope === "thread";
  return {
    installId: install.pluginId,
    pluginName: install.name,
    displayName: install.displayName,
    scope: install.scope,
    targetId: install.targetId,
    version: install.version,
    integrity: install.integrity,
    // Install-wide work of a workspace install runs as its installer, not
    // as whichever member's Thread reached it first.
    ownerUserId:
      threadScoped && dependencies.threadId !== undefined
        ? dependencies.ownerUserId
        : install.scope === "workspace"
          ? (install.installedByUserId ?? dependencies.ownerUserId)
          : dependencies.ownerUserId,
    ...(threadScoped && dependencies.threadId !== undefined
      ? { threadId: dependencies.threadId }
      : {}),
    tier: callTier(dependencies),
    workspaceId:
      dependencies.workspaceId ??
      (install.scope === "workspace" ? install.targetId : ""),
    jobs: install.code.jobs ?? [],
    durableScope: threadScoped ? "thread" : "install",
  };
};

export const durableStub = (bindings: Bindings, meta: DurableMeta) => {
  const namespace = durableNamespace(bindings);
  if (namespace === undefined)
    throw new Error(
      "This deployment has no Durable Object host for plugins (PLUGIN_DURABLE_HOST).",
    );
  return namespace.get(
    namespace.idFromName(durableObjectName(meta.installId, meta.threadId)),
  );
};
