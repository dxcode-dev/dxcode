import { effectiveArchivedMode, pluginHostKinds } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../../http/types.js";
import { listThreadCodePluginInstalls } from "../../worker-host/resolve.js";
import { tierAllowsHost } from "../policy.js";
import { callTierOf as callTier } from "../tier.js";
import { durableArchivedMode } from "./archived.js";
import { durableMetaOf, durableNamespace, durableStub } from "./client.js";

const logger = getLogger(["dx", "plugins", "hosts", "durable"]);

/**
 * Archiving a Thread pauses its thread-scoped plugins' jobs and closes
 * their watches, unless the plugin runs there as `archivedThreads: "live"`
 * (trusted tiers); restoring it resumes them. One D1 read for the Thread's
 * installs, only when a Thread is archived or restored; never throws.
 */
export const durableThreadLifecycle = async (
  bindings: Bindings,
  threadId: string,
  archived: boolean,
  requestId?: string,
) => {
  if (durableNamespace(bindings) === undefined) return;
  const db = bindings.DB as D1Database;
  try {
    const owner = await db
      .prepare("SELECT owner_user_id FROM threads WHERE id = ?")
      .bind(threadId)
      .first<{ owner_user_id: string }>();
    if (owner === null) return;
    const installs = (await listThreadCodePluginInstalls(db, threadId)).filter(
      (install) =>
        install.code.durableScope === "thread" &&
        (install.code.jobs?.length ?? 0) +
          (install.code.hosts?.durable === undefined ? 0 : 1) >
          0,
    );
    await Promise.all(
      installs.map(async (install) => {
        const dependencies = {
          db,
          bindings,
          install,
          ownerUserId: owner.owner_user_id,
          threadId,
        };
        const tier = callTier(dependencies);
        if (!tierAllowsHost(tier, "durable")) return;
        const live =
          effectiveArchivedMode(
            durableArchivedMode(install.code),
            tier,
            pluginHostKinds(install.code),
          ).mode === "live";
        const meta = durableMetaOf({ ...dependencies, tier });
        const stub = durableStub(bindings, meta);
        if (archived && !live) await stub.stop("archived");
        // Live: jobs keep running, but without posts or wakes from now on.
        else if (archived) await stub.archivedLive();
        else await stub.resume(meta);
        logger.info(
          `Plugin ${install.name}'s Thread jobs ${archived ? (live ? "keep running (live)" : "paused") : "resumed"}.`,
          {
            event: "plugin_durable_thread_lifecycle",
            requestId,
            installId: install.pluginId,
            host: "durable",
            tier,
            threadId,
            outcome: archived ? (live ? "live" : "paused") : "resumed",
          },
        );
      }),
    );
  } catch (error) {
    logger.warn("Plugin durable hosts did not follow the Thread's archive.", {
      event: "plugin_durable_thread_lifecycle_failed",
      requestId,
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
