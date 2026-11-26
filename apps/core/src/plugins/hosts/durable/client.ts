import type { Bindings } from "../../../http/types.js";
import type { PluginDurableHostObject } from "./object.js";

/**
 * How dx reaches an install's Durable Object: one per install, named by
 * the install's ID. It holds the install's URL listeners open (object-host.ts);
 * the scheduler, state, and install actions live in D1 and need no object.
 */

export const durableNamespace = (bindings: Bindings) =>
  bindings.PLUGIN_DURABLE_HOST as
    | DurableObjectNamespace<PluginDurableHostObject>
    | undefined;

export const durableStub = (bindings: Bindings, installId: string) => {
  const namespace = durableNamespace(bindings);
  if (namespace === undefined)
    throw new Error(
      "This deployment has no Durable Object host for plugins (PLUGIN_DURABLE_HOST).",
    );
  return namespace.get(namespace.idFromName(installId));
};

/** What `ensure` reports: the listeners open now. */
export interface DurableListenerStatus {
  readonly installId: string;
  readonly listening: ReadonlyArray<string>;
}
