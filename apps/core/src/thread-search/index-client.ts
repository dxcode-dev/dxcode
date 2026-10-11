import type { Bindings } from "../http/types.js";
import type { ThreadSearchIndexObject } from "./index-object.js";

/** The index of one owner's Threads, or undefined when not deployed. */
export const ownerSearchIndex = (bindings: Bindings, ownerUserId: string) => {
  const namespace = bindings.THREAD_SEARCH_INDEX as
    | DurableObjectNamespace<ThreadSearchIndexObject>
    | undefined;
  return namespace?.get(namespace.idFromName(`owner:${ownerUserId}`));
};
