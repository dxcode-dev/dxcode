import { AsyncLocalStorage } from "node:async_hooks";
import type { ThreadChangesMutationLease } from "../thread-changes/repository-d1.js";

/**
 * A Changes mutation lease that a command's authorization took in its own
 * D1 batch, handed to that same command's Changes coordination so it takes
 * no lease of its own. Scoped to the one command through async context, so
 * concurrent commands never take each other's lease.
 */
interface CommandLeaseSlot {
  readonly lease: ThreadChangesMutationLease;
  taken: boolean;
}

const commandLease = new AsyncLocalStorage<CommandLeaseSlot>();

/**
 * Runs one command with the lease its authorization took. A lease the
 * command never took (it was refused before Changes coordination) is
 * released, so it holds no capture back.
 */
export const runWithCommandLease = async <A>(
  lease: ThreadChangesMutationLease,
  run: () => Promise<A>,
): Promise<A> => {
  const slot: CommandLeaseSlot = { lease, taken: false };
  try {
    return await commandLease.run(slot, run);
  } finally {
    if (!slot.taken) await lease.release().catch(() => undefined);
  }
};

/** The lease this command's authorization took, once; otherwise none. */
export const takeCommandLease = (): ThreadChangesMutationLease | undefined => {
  const slot = commandLease.getStore();
  if (slot === undefined || slot.taken) return undefined;
  slot.taken = true;
  return slot.lease;
};
