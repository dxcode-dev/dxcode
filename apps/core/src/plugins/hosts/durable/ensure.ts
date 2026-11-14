import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../../http/types.js";
import type { PluginInstallRecord } from "../../worker-host/host.js";
import { tierAllowsHost } from "../policy.js";
import { callTierOf as callTier } from "../tier.js";
import { durableMetaOf, durableNamespace, durableStub } from "./client.js";

const logger = getLogger(["dx", "plugins", "hosts", "durable"]);

/** Install versions and Threads whose objects already have their jobs. */
const ensured = new Set<string>();

/**
 * Starts the declared `every` and `cron` jobs of each trusted install with
 * jobs, in its Durable Object (per install, or per install and Thread).
 * Once per isolate per install version and object; returns undefined when
 * nothing needed starting.
 */
export const ensureDurableJobs = (
  bindings: Bindings,
  db: D1Database,
  installs: ReadonlyArray<PluginInstallRecord>,
  ownerUserId: string,
  threadId: string,
): Promise<unknown> | undefined => {
  if (durableNamespace(bindings) === undefined) return undefined;
  const work: Array<Promise<unknown>> = [];
  for (const install of installs) {
    const scheduled = (install.code.jobs ?? []).some(
      (job) => !("at" in job.schedule),
    );
    if (!scheduled) continue;
    const dependencies = { db, bindings, install, ownerUserId, threadId };
    const tier = callTier(dependencies);
    if (!tierAllowsHost(tier, "durable")) continue;
    const meta = durableMetaOf({ ...dependencies, tier });
    const key = `${install.pluginId}:${install.integrity}:${tier}:${meta.threadId ?? ""}`;
    if (ensured.has(key)) continue;
    ensured.add(key);
    work.push(
      durableStub(bindings, meta)
        .ensure(meta)
        .catch((error: unknown) => {
          ensured.delete(key);
          logger.warn(`Plugin ${install.name}'s jobs did not start.`, {
            event: "plugin_durable_ensure_failed",
            installId: install.pluginId,
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  }
  return work.length === 0 ? undefined : Promise.all(work);
};
