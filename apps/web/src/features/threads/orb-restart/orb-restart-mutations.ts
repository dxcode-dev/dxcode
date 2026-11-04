import type { ThreadId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { ApiError, restartThreadOrb } from "../../../shared/api/client.js";
import { invalidateOrbDisk } from "../orb-disk/orb-disk-queries.js";
import { invalidateOrbMemory } from "../orb-memory/orb-memory-queries.js";

/**
 * Restart Orb (#1592). A restarted Orb's memory and disk readings start
 * over, so the notices read them again.
 */
export const restartOrbMutationOptions = (
  queryClient: QueryClient,
  threadId: ThreadId,
) =>
  mutationOptions({
    mutationKey: ["threads", threadId, "orb", "restart"] as const,
    mutationFn: (input: { readonly discardUnsaved?: true } = {}) =>
      restartThreadOrb(threadId, input),
    onSuccess: () => {
      void invalidateOrbMemory(queryClient, threadId);
      void invalidateOrbDisk(queryClient, threadId);
    },
  });

/**
 * The last good save a refused restart could start from instead, when the
 * Orb's files couldn't be saved (#1614).
 */
export const lastSaveOf = (error: unknown) => {
  if (!(error instanceof ApiError) || error.code !== "ORB_RESTART_UNSAVED")
    return undefined;
  const at = error.data?.lastSavedAt;
  return typeof at === "string" ? new Date(at) : undefined;
};
