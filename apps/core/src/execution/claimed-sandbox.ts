import { executionWorkspaceLogger } from "../logging.js";
import type {
  ExecutionWorkspaceRecord,
  ExecutionWorkspaceRecords,
} from "./workspace-record.js";

/**
 * A provider sandbox carrying dx's tags: the Thread it was made for, and the
 * attempt (the claim's `initialization_attempt_id`) that made it.
 */
export interface TaggedSandbox {
  readonly id: string;
  /** Absent on sandboxes made before dx tagged attempts. */
  readonly attempt?: string;
}

/** The provider side of {@link openClaimedSandbox}. */
export interface ClaimedSandboxProvider {
  /** Every sandbox tagged with the Thread, whatever its state. */
  readonly tagged: (threadId: string) => Promise<ReadonlyArray<TaggedSandbox>>;
  /** Creates the Thread's sandbox tagged with `attempt`; its ID. */
  readonly create: (threadId: string, attempt: string) => Promise<string>;
  readonly remove: (sandboxId: string) => Promise<void>;
  /** A failed create the provider refused, so no sandbox exists for it. */
  readonly refused: (cause: unknown) => boolean;
}

export type ClaimedSandbox =
  /** The record already holds a sandbox: reconnect to it. */
  | { readonly kind: "recorded"; readonly record: ExecutionWorkspaceRecord }
  /** This call made the sandbox, or found the one its claim's holder made. */
  | { readonly kind: "opened"; readonly sandboxId: string };

/**
 * How long a claim may show no tagged sandbox before another activation
 * takes it over. Its holder creates right after claiming, and Agent37 lists
 * a new instance within seconds while its create is still waiting for it to
 * run (checked live, 2026-11-27), so a claim this old with nothing listed
 * lost its holder before the create reached the provider: a Worker cancels
 * `waitUntil` work 30 s after its response.
 */
export const CLAIM_STALE_MS = 45_000;
const POLL_MS = 2_000;
/** How long one activation waits on another's claim. */
const WAIT_MS = 120_000;

export interface OpenClaimedSandboxOptions {
  readonly provider: string;
  readonly existingOnly: boolean;
  readonly authorize: () => Promise<void>;
  readonly unavailable: (reason: string) => Error;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly staleMs?: number;
  readonly pollMs?: number;
  readonly waitMs?: number;
}

const removeStray = async (
  provider: Pick<ClaimedSandboxProvider, "remove">,
  providerId: string,
  threadId: string,
  sandboxId: string,
  reason: string,
) => {
  try {
    await provider.remove(sandboxId);
    executionWorkspaceLogger.warn("Removed an unrecorded Orb.", {
      event: "execution_workspace_stray_removed",
      provider: providerId,
      threadId,
      sandboxId,
      reason,
    });
  } catch (cause) {
    executionWorkspaceLogger.warn("An unrecorded Orb could not be removed.", {
      event: "execution_workspace_stray_remove_failed",
      provider: providerId,
      threadId,
      sandboxId,
      reason,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

/**
 * Deletes every sandbox tagged with the Thread except `kept`, the one its
 * record holds. Never throws: a failed listing or delete is logged and the
 * next pass tries again.
 */
export const removeStraySandboxes = async (
  provider: Pick<ClaimedSandboxProvider, "tagged" | "remove">,
  providerId: string,
  threadId: string,
  kept: string,
) => {
  const tagged = await provider.tagged(threadId).catch(() => []);
  await Promise.all(
    tagged
      .filter(({ id }) => id !== kept)
      .map(({ id }) =>
        removeStray(provider, providerId, threadId, id, "stray"),
      ),
  );
};

/**
 * Resolves the Thread's one provider sandbox without ever leaving one
 * behind. Only the activation that claims the record creates, tagging the
 * sandbox with its attempt; every other activation waits and adopts the
 * sandbox tagged with the claim's attempt rather than making a second one.
 * A claim whose holder vanished before its create reached the provider
 * (nothing tagged, and the claim older than {@link CLAIM_STALE_MS}) is
 * taken over under a new attempt. Once a sandbox is recorded, every other
 * sandbox tagged with the Thread is deleted: one a cancelled create made
 * after its holder lost the claim, or one made before dx tagged attempts.
 *
 * Without this, two activations (a new Thread's early Orb start and its
 * first run) each created an Agent37 instance, and the one whose request
 * was cancelled mid-create left its instance running unrecorded, billed
 * and never slept.
 */
export const openClaimedSandbox = async (
  records: ExecutionWorkspaceRecords,
  threadId: string,
  provider: ClaimedSandboxProvider,
  options: OpenClaimedSandboxOptions,
): Promise<ClaimedSandbox> => {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const staleMs = options.staleMs ?? CLAIM_STALE_MS;
  const deadline = now() + (options.waitMs ?? WAIT_MS);

  const create = async (claim: ExecutionWorkspaceRecord) => {
    const attempt = claim.initializationAttemptId;
    if (attempt === null) throw options.unavailable("claim without attempt");
    let sandboxId: string;
    try {
      sandboxId = await provider.create(threadId, attempt);
    } catch (cause) {
      // Nothing was made: the next activation may claim and create again.
      if (provider.refused(cause)) await records.release(threadId, claim);
      throw cause;
    }
    return record(claim, sandboxId);
  };

  /** Records `sandboxId` for `claim`; the sandbox the record holds. */
  const record = async (claim: ExecutionWorkspaceRecord, sandboxId: string) => {
    if (!(await records.initialize(threadId, claim, sandboxId))) {
      const current = await records.read(threadId);
      // Another activation adopted this very sandbox first.
      if (
        current?.state !== "initialized" ||
        current.providerSandboxId !== sandboxId
      ) {
        await removeQuietly(sandboxId, "lost-claim");
        return undefined;
      }
    }
    await removeStrays(sandboxId);
    return sandboxId;
  };

  const removeQuietly = (sandboxId: string, reason: string) =>
    removeStray(provider, options.provider, threadId, sandboxId, reason);
  const removeStrays = (kept: string) =>
    removeStraySandboxes(provider, options.provider, threadId, kept);

  for (;;) {
    const current = await records.read(threadId);
    if (current === null) throw options.unavailable("no workspace record");
    if (current.state === "uninitialized") {
      if (options.existingOnly) throw options.unavailable("not created");
      await options.authorize();
      const claim = await records.claim(threadId);
      if (claim === null) continue;
      const sandboxId = await create(claim);
      if (sandboxId !== undefined) return { kind: "opened", sandboxId };
      continue;
    }
    // Pinned to another provider: never reached through this one.
    if (current.provider !== options.provider)
      throw options.unavailable("other provider");
    if (current.state !== "provisioning")
      return { kind: "recorded", record: current };
    if (options.existingOnly) throw options.unavailable("not created");
    await options.authorize();
    // Another activation holds the claim: adopt what it made.
    const made = (await provider.tagged(threadId)).find(
      ({ attempt }) =>
        attempt !== undefined && attempt === current.initializationAttemptId,
    );
    if (made !== undefined) {
      const sandboxId = await record(current, made.id);
      if (sandboxId !== undefined) return { kind: "opened", sandboxId };
      continue;
    }
    const taken = await records.retake(
      threadId,
      current,
      new Date(now() - staleMs).toISOString(),
    );
    if (taken !== null) {
      executionWorkspaceLogger.warn("Took over an abandoned Orb claim.", {
        event: "execution_workspace_claim_retaken",
        provider: options.provider,
        threadId,
      });
      const sandboxId = await create(taken);
      if (sandboxId !== undefined) return { kind: "opened", sandboxId };
      continue;
    }
    if (now() > deadline) throw options.unavailable("still provisioning");
    await sleep(options.pollMs ?? POLL_MS);
  }
};
