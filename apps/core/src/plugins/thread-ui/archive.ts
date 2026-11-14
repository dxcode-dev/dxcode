import type { PluginCodeEvent } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../http/types.js";
import { mapPluginsLimited } from "../worker-host/concurrency.js";
import { listThreadCodePluginInstalls } from "../worker-host/resolve.js";
import { dispatchPluginEvent } from "../worker-host/worker.js";
import { wakePromptWaiter } from "./prompt-wake.js";
import { invalidatePluginUi } from "./store.js";

/**
 * What plugins hear when a Thread is archived or restored.
 * On archive, prompts still waiting are cancelled, since answering them
 * needs the agent, and every install handling `thread.archived` gets it once
 * to clean up (stop devices, save a pane snapshot). On restore, those
 * handling `thread.unarchived` get it. Each handler has 10 seconds and no
 * Orb: the call carries no tool runner and no shell gate.
 */

const logger = getLogger(["dx", "plugins", "archive"]);

/** Each plugin's handlers have this long. */
export const ARCHIVE_EVENT_TIMEOUT_MS = 10_000;

/** Cancels the Thread's waiting prompts; their calls read them as gone. */
export const cancelWaitingPrompts = async (
  db: D1Database,
  threadId: string,
) => {
  const cancelled = await db
    .prepare(
      `UPDATE plugin_ui_prompt SET status = 'expired', answered_at = ?2
        WHERE thread_id = ?1 AND status = 'pending'
        RETURNING id`,
    )
    .bind(threadId, new Date().toISOString())
    .all<{ id: string }>();
  for (const { id } of cancelled.results) wakePromptWaiter(id);
  return cancelled.results.length;
};

export const notifyPluginsOfArchive = async (
  bindings: Bindings,
  input: {
    readonly threadId: string;
    readonly ownerUserId: string;
    readonly archived: boolean;
    readonly requestId: string;
  },
) => {
  const db = bindings.DB;
  if (db === undefined) return;
  const event: PluginCodeEvent = input.archived
    ? "thread.archived"
    : "thread.unarchived";
  const started = Date.now();
  const [cancelled, installs] = await Promise.all([
    input.archived ? cancelWaitingPrompts(db, input.threadId) : 0,
    listThreadCodePluginInstalls(db, input.threadId),
  ]);
  if (cancelled > 0) {
    logger.info("Archived Thread's waiting plugin prompts cancelled.", {
      event: "plugin_prompts_cancelled_on_archive",
      requestId: input.requestId,
      threadId: input.threadId,
      cancelled,
      ms: Date.now() - started,
    });
    await invalidatePluginUi(bindings, input.threadId).catch(() => undefined);
  }
  // Under the per-request Dynamic Worker limit, as describing them is.
  await mapPluginsLimited(
    installs.filter((install) =>
      install.code.permissions.events.includes(event),
    ),
    async (install) => {
      const callStarted = Date.now();
      let outcome = "ok";
      let error: string | undefined;
      try {
        await dispatchPluginEvent(
          {
            db,
            bindings,
            install,
            threadId: input.threadId,
            ownerUserId: input.ownerUserId,
          },
          event,
          { threadId: input.threadId },
          ARCHIVE_EVENT_TIMEOUT_MS,
        );
      } catch (cause) {
        outcome = "failed";
        error =
          cause instanceof Error ? cause.message.slice(0, 500) : String(cause);
      }
      logger.info(`Plugin ${install.name} heard ${event}.`, {
        event: "plugin_archive_event",
        pluginEvent: event,
        requestId: input.requestId,
        threadId: input.threadId,
        installId: install.pluginId,
        host: "worker",
        tier: install.tier ?? "sandboxed",
        outcome,
        ms: Date.now() - callStarted,
        ...(error === undefined ? {} : { error }),
      });
    },
  );
};
