import type { PluginJobsData } from "@dx/api";
import type { StoredPluginBundle } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../../http/types.js";
import { insertPluginAudit } from "../../audit/audit.js";
import { configuredTierLimits } from "../../trust/limits.js";
import {
  type InstallTrust,
  installedPluginTier,
  installTrustColumns,
  installTrustFromRow,
} from "../../trust/resolve-tier.js";
import type { PluginInstallRecord } from "../../worker-host/host.js";
import { tierAllowsHost } from "../policy.js";
import { callTierOf as callTier } from "../tier.js";
import { durableMetaOf, durableNamespace, durableStub } from "./client.js";

/**
 * The Plugins page's view of a plugin's jobs, and its Stop and Start
 * buttons. Reads the install's Durable Object, which also holds what its
 * Thread objects last reported; one D1 read only for the viewer's Thread
 * titles.
 */

const logger = getLogger(["dx", "plugins", "hosts", "durable"]);

const installOf = (
  bundle: StoredPluginBundle,
  trust: InstallTrust,
): PluginInstallRecord | undefined =>
  bundle.manifest.code === undefined
    ? undefined
    : {
        pluginId: bundle.id,
        name: bundle.name,
        displayName: bundle.manifest.displayName,
        scope: bundle.target.scope,
        targetId: bundle.target.id,
        version: bundle.version,
        integrity: bundle.integrity,
        code: bundle.manifest.code,
        installedByUserId: bundle.installedByUserId,
        tier: installedPluginTier(
          bundle.target.scope,
          bundle.manifest.code.tier,
          trust,
        ),
      };

/** The workspace's cap and trusted signers for the install: one read. */
const trustOf = async (
  bindings: Bindings,
  bundle: StoredPluginBundle,
): Promise<InstallTrust> => {
  const row = await (bindings.DB as D1Database)
    .prepare(
      `SELECT ${installTrustColumns("plugin")}
         FROM trusted_plugin plugin WHERE plugin.id = ?1`,
    )
    .bind(bundle.id)
    .first<{ tier_cap: string | null; trusted_signature: number | null }>();
  return installTrustFromRow(row ?? { tier_cap: null, trusted_signature: 0 });
};

const context = async (
  bindings: Bindings,
  bundle: StoredPluginBundle,
  viewerUserId: string,
) => {
  const install = installOf(bundle, await trustOf(bindings, bundle));
  if (install === undefined) return undefined;
  // Install-wide jobs run as the member who installed the plugin.
  const ownerUserId =
    install.scope === "personal" ? viewerUserId : bundle.installedByUserId;
  const dependencies = {
    db: bindings.DB as D1Database,
    bindings,
    install,
    ownerUserId,
  };
  const tier = callTier(dependencies);
  return { install, tier, meta: durableMetaOf({ ...dependencies, tier }) };
};

const log = (fields: {
  readonly requestId: string;
  readonly installId: string;
  readonly tier: string;
  readonly action: string;
  readonly outcome: string;
  readonly started: number;
  readonly job?: string;
  readonly threadId?: string;
}) =>
  logger[fields.outcome === "ok" ? "info" : "warn"](
    `Plugin jobs ${fields.action}: ${fields.outcome}.`,
    {
      event: "plugin_jobs_route",
      requestId: fields.requestId,
      installId: fields.installId,
      host: "durable",
      tier: fields.tier,
      action: fields.action,
      outcome: fields.outcome,
      ms: Date.now() - fields.started,
      ...(fields.job === undefined ? {} : { job: fields.job }),
      ...(fields.threadId === undefined ? {} : { threadId: fields.threadId }),
    },
  );

export const pluginJobsView = async (input: {
  readonly bindings: Bindings;
  readonly bundle: StoredPluginBundle;
  readonly viewerUserId: string;
  readonly canMutate: boolean;
  readonly requestId: string;
}): Promise<PluginJobsData> => {
  const started = Date.now();
  const resolved = await context(
    input.bindings,
    input.bundle,
    input.viewerUserId,
  );
  const declared = (input.bundle.manifest.code?.jobs ?? []).map((job) => ({
    id: job.id,
    title: job.title,
    schedule: job.schedule,
    status: "stopped" as const,
    runs: 0,
  }));
  const empty = {
    jobs: declared,
    watches: [],
    storage: { sqlBytes: 0, blobBytes: 0 },
    canMutate: input.canMutate,
  };
  if (resolved === undefined)
    return { available: false, reason: "no-code", jobLimit: 0, ...empty };
  const { tier, meta } = resolved;
  const limit = configuredTierLimits(input.bindings, tier).jobs;
  if (!tierAllowsHost(tier, "durable")) {
    log({
      requestId: input.requestId,
      installId: meta.installId,
      tier,
      action: "list",
      outcome: "blocked-tier",
      started,
    });
    return { available: false, reason: "blocked-tier", jobLimit: 0, ...empty };
  }
  if (durableNamespace(input.bindings) === undefined)
    return {
      available: false,
      reason: "not-deployed",
      jobLimit: limit,
      ...empty,
    };
  const view = await durableStub(input.bindings, meta).jobsView(meta);
  const threadIds = [
    ...new Set(
      view.jobs.flatMap(({ threadId }) =>
        threadId === undefined ? [] : [threadId],
      ),
    ),
  ].slice(0, 100);
  // The viewer's own Threads among them, with their titles.
  const titles = new Map<string, string>();
  const own = new Set<string>();
  if (threadIds.length > 0) {
    const rows = await (input.bindings.DB as D1Database)
      .prepare(
        `SELECT id, title FROM threads WHERE owner_user_id = ?1
            AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(input.viewerUserId, JSON.stringify(threadIds))
      .all<{ id: string; title: string | null }>();
    for (const row of rows.results) {
      own.add(row.id);
      if (row.title !== null) titles.set(row.id, row.title);
    }
  }
  log({
    requestId: input.requestId,
    installId: meta.installId,
    tier,
    action: "list",
    outcome: "ok",
    started,
  });
  return {
    available: true,
    jobLimit: limit,
    // Someone who may only read the plugin sees the install's own jobs and
    // their own Threads' jobs, without error text or watch targets, which
    // can name other members' work or carry tokens.
    jobs: view.jobs.flatMap((job) => {
      if (
        !input.canMutate &&
        job.threadId !== undefined &&
        !own.has(job.threadId)
      )
        return [];
      const title =
        job.threadId === undefined ? undefined : titles.get(job.threadId);
      const shown = title === undefined ? job : { ...job, threadTitle: title };
      if (input.canMutate) return [shown];
      const { lastError: _hidden, ...rest } = shown;
      return [rest];
    }),
    watches: input.canMutate
      ? view.watches
      : view.watches.map((watch) => ({ ...watch, target: "" })),
    storage: view.storage,
    canMutate: input.canMutate,
  };
};

export const pluginJobAction = async (input: {
  readonly bindings: Bindings;
  readonly bundle: StoredPluginBundle;
  readonly viewerUserId: string;
  readonly requestId: string;
  readonly action: "stop" | "start";
  readonly jobId: string;
  readonly threadId?: string;
}) => {
  const started = Date.now();
  const resolved = await context(
    input.bindings,
    input.bundle,
    input.viewerUserId,
  );
  if (resolved === undefined || durableNamespace(input.bindings) === undefined)
    return false;
  const { tier, meta } = resolved;
  if (!tierAllowsHost(tier, "durable")) {
    log({
      requestId: input.requestId,
      installId: meta.installId,
      tier,
      action: input.action,
      outcome: "blocked-tier",
      started,
      job: input.jobId,
    });
    return false;
  }
  const stub = durableStub(input.bindings, meta);
  if (input.action === "stop")
    await stub.stopJob(meta, input.jobId, input.threadId);
  else await stub.startJob(meta, input.jobId, input.threadId);
  await insertPluginAudit(input.bindings.DB as D1Database, {
    pluginId: meta.installId,
    pluginName: meta.pluginName,
    pluginVersion: meta.version,
    scope: meta.scope,
    // The person who pressed Stop or Start.
    ownerUserId: input.viewerUserId,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    action: `job.${input.action}`,
    target: `${input.jobId}@${input.threadId ?? "install"}`,
    outcome: "success",
    requestId: input.requestId,
  });
  log({
    requestId: input.requestId,
    installId: meta.installId,
    tier,
    action: input.action,
    outcome: "ok",
    started,
    job: input.jobId,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  });
  return true;
};
