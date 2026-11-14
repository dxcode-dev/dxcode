import { getLogger } from "@logtape/logtape";
import { listOwnerCodePluginInstalls } from "../worker-host/resolve.js";
import { installTier, showsViews } from "./tier.js";

/**
 * Plugin Thread types. A Thread is given a type (`<plugin>/<type>`)
 * only when it is created, and keeps it. Creation checks the owner has the
 * plugin installed and on, that its manifest declares the type, and that
 * it runs at the trusted tier; opening the Thread later checks again, and
 * shows a plain chat with a notice when the type is no longer available.
 */

const logger = getLogger(["dx", "plugins", "views"]);

export class PluginThreadTypeNotOffered extends Error {
  override readonly name = "PluginThreadTypeNotOffered";
}

export const checkPluginThreadType = async (
  db: D1Database,
  input: {
    readonly ownerUserId: string;
    readonly ref: string;
    readonly requestId?: string;
  },
) => {
  const started = Date.now();
  const [plugin = "", type = ""] = input.ref.split("/");
  const install = (
    await listOwnerCodePluginInstalls(db, input.ownerUserId)
  ).find((candidate) => candidate.name === plugin);
  const declared = install?.code.views?.threadTypes.find(
    ({ id }) => id === type,
  );
  const reason =
    install === undefined
      ? "not-installed"
      : declared === undefined
        ? "not-declared"
        : !showsViews(install)
          ? "tier"
          : undefined;
  logger.info("Plugin Thread type checked.", {
    event: "plugin_thread_type_checked",
    requestId: input.requestId,
    installId: install?.pluginId,
    threadType: input.ref,
    host: "worker",
    tier: install === undefined ? undefined : installTier(install),
    outcome: reason === undefined ? "allowed" : `refused:${reason}`,
    ms: Date.now() - started,
  });
  if (reason === "not-installed")
    throw new PluginThreadTypeNotOffered(
      `${plugin} is not installed, or is off, so you cannot start its Thread type.`,
    );
  if (reason === "not-declared")
    throw new PluginThreadTypeNotOffered(
      `${plugin} declares no Thread type named ${type}.`,
    );
  if (reason === "tier")
    throw new PluginThreadTypeNotOffered(
      `${plugin}'s Thread types need a trusted tier; this install runs sandboxed.`,
    );
};
