import { MAX_SHIP_PROMPT_LENGTH } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../http/types.js";
import type { PluginInstallRecord } from "./host.js";
import {
  describeCodePlugins,
  listThreadCodePluginInstalls,
} from "./resolve.js";
import { dispatchPluginEvent, logPluginFailure } from "./worker.js";

/**
 * The `changes.prompt` event: when the Changes pane asks for the Ship plan,
 * the Thread's installed plugins whose code handles it may rewrite the
 * project's Ship prompt, in the resolved order, each seeing the prompt the
 * last one returned. The pane shows a rewritten prompt, and names the
 * plugins that changed it, before the person sends it as their own message.
 *
 * Asking for the plan has no side effects to speak of: the event's context
 * has no model calls, UI, network, secrets, dx tools, or Threads; one
 * deadline bounds every plugin together; and a plugin that fails or runs out
 * of time is skipped (fail open), as is the whole step when it cannot run.
 * Repository plugins are not asked: reading them needs the Orb, and showing
 * the plan must not wake it.
 */

const logger = getLogger(["dx", "plugins", "changes-prompt"]);

/** A Ship prompt's own limit applies to a plugin's prompt too. */
export const MAX_CHANGES_PROMPT_CHARACTERS = MAX_SHIP_PROMPT_LENGTH;
/** Every plugin together, so asking for the plan stays quick. */
export const CHANGES_PROMPT_DEADLINE_MS = 8_000;

/** The install as this event sees it: nothing beyond its own storage. */
const pure = (install: PluginInstallRecord): PluginInstallRecord => ({
  ...install,
  code: {
    ...install.code,
    permissions: {
      ...install.code.permissions,
      network: [],
      secrets: [],
      tools: [],
      ai: false,
      threads: false,
      ...("ui" in install.code.permissions ? { ui: [] } : {}),
    },
  },
});

/** Cuts at a character, never inside a surrogate pair. */
const bounded = (text: string) =>
  Array.from(text).slice(0, MAX_CHANGES_PROMPT_CHARACTERS).join("");

export interface ShapedPrompt {
  readonly prompt: string;
  /** Display names of the plugins that changed it, in order. */
  readonly shapedBy: ReadonlyArray<string>;
}

export const applyChangesPromptPlugins = async (
  bindings: Bindings,
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly ownerUserId: string;
    readonly action: string;
    readonly baseBranch?: string;
    readonly prompt: string;
  },
): Promise<ShapedPrompt> => {
  const unchanged = { prompt: input.prompt, shapedBy: [] };
  const deadline = Date.now() + CHANGES_PROMPT_DEADLINE_MS;
  try {
    // Only installs that declare the event start a worker.
    const installs = (
      await listThreadCodePluginInstalls(db, input.threadId)
    ).filter((install) =>
      install.code.permissions.events.includes("changes.prompt"),
    );
    if (installs.length === 0) return unchanged;
    const plugins = (await describeCodePlugins(bindings, db, installs)).filter(
      (plugin) =>
        plugin.loadError === undefined &&
        plugin.events.includes("changes.prompt"),
    );
    let prompt = input.prompt;
    const shapedBy: Array<string> = [];
    for (const plugin of plugins) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const result = await dispatchPluginEvent(
          {
            db,
            bindings,
            install: pure(plugin),
            threadId: input.threadId,
            ownerUserId: input.ownerUserId,
          },
          "changes.prompt",
          {
            threadId: input.threadId,
            action: input.action,
            ...(input.baseBranch === undefined
              ? {}
              : { baseBranch: input.baseBranch }),
            prompt,
          },
          remaining,
        );
        const next =
          typeof result === "object" &&
          result !== null &&
          typeof (result as { prompt?: unknown }).prompt === "string"
            ? bounded((result as { prompt: string }).prompt.trim())
            : "";
        if (next !== "" && next !== prompt) {
          prompt = next;
          shapedBy.push(plugin.displayName);
        }
      } catch (error) {
        logPluginFailure(plugin, "changes.prompt", error);
      }
    }
    return { prompt, shapedBy };
  } catch (error) {
    // Plugins are optional here: Ship keeps working with dx's own prompt.
    logger.warn("Plugins could not shape the Ship prompt.", {
      event: "changes_prompt_failed",
      threadId: input.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return unchanged;
  }
};
