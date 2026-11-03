// An Orb can stop answering while its container still reports running: on
// 2026-11-03 two full jest runs wedged thr_6352fb61's Orb, every guest
// command hung, and each new message's activation waited in source
// preparation for ten minutes and more, so the Thread stayed "working"
// (#1584).
//
// A run's activation watches source preparation. Past a short while, or
// when a setup command is lost or times out, it asks the Orb to run a
// trivial command; a busy Orb answers, a wedged one does not. After two
// unanswered checks in a row, dx restarts the Orb once
// through its provider, keeping its files (`recover` without
// `discardUnsaved` never drops them), and prepares the restarted Orb. The
// turn starts with a note saying so. dx restarts a Thread's Orb at most once
// in ORB_RESTART_WINDOW_MS; otherwise, and when the Orb can't be restarted
// without losing files, the run settles as `workspace_unresponsive` saying
// what the person can do.

import type { ThreadId } from "@dx/domain";
import { FlueError } from "@flue/runtime";
import { executionWorkspaceLogger } from "../logging.js";
import { rememberWorkspaceRecovery } from "../orb-disk/read-only.js";
import type {
  ExecutionContext,
  ExecutionGuest,
  ExecutionProvider,
  ExecutionWorkspaceHandle,
  ExecutionWorkspaceRecovery,
} from "../plugins/execution/provider.js";

/** How long source preparation runs before dx checks that the Orb answers. */
export const ORB_LIVENESS_WATCH_MS = 45_000;
/** A trivial command's budget: an overloaded Orb answers within it. */
export const ORB_LIVENESS_PROBE_MS = 60_000;
/** Unanswered checks in a row before dx counts the Orb as stopped. */
const ORB_LIVENESS_MISSES = 2;
/** At most one automatic restart per Thread in this window. */
export const ORB_RESTART_WINDOW_MS = 10 * 60_000;

export const WORKSPACE_UNRESPONSIVE_CODE = "WORKSPACE_UNRESPONSIVE";

const MANUAL_RESTART =
  "To restart it yourself with its files kept, archive the Thread and restore it.";

const unresponsiveRunError = (details: string) =>
  new FlueError({
    type: "workspace_unresponsive",
    message: "The Orb stopped responding.",
    details,
    dev: "",
    meta: { code: WORKSPACE_UNRESPONSIVE_CODE },
  });

const sleep = (ms: number) =>
  new Promise<"elapsed">((resolve) => setTimeout(() => resolve("elapsed"), ms));

/** Whether the guest runs a trivial command within the probe budget. */
const answers = async (guest: ExecutionGuest) => {
  const probe = guest.commands
    .run("true", { timeoutMs: ORB_LIVENESS_PROBE_MS })
    .then(
      () => "answered" as const,
      () => "failed" as const,
    );
  // The provider's own timeout may never fire when the guest is wedged.
  return (
    (await Promise.race([probe, sleep(ORB_LIVENESS_PROBE_MS + 5_000)])) ===
    "answered"
  );
};

const UNRESPONSIVE = Symbol("unresponsive");

/** The operation's result, or UNRESPONSIVE once the guest stops answering. */
const whileAnswering = async <A>(
  guest: ExecutionGuest,
  operation: Promise<A>,
): Promise<A | typeof UNRESPONSIVE> => {
  // A failure after the Orb was given up on has no one to report to.
  operation.catch(() => undefined);
  const done = operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let misses = 0;
  while (true) {
    // Watch while the Orb answers; check again at once after a miss.
    if (misses === 0) {
      const watched = await Promise.race([done, sleep(ORB_LIVENESS_WATCH_MS)]);
      if (watched !== "elapsed") break;
    }
    const checked = await Promise.race([
      done,
      answers(guest).then((ok) => (ok ? "answered" : "missed")),
    ]);
    if (checked === "missed") {
      misses += 1;
      if (misses >= ORB_LIVENESS_MISSES) return UNRESPONSIVE;
    } else if (checked === "answered") misses = 0;
    else break;
  }
  const settled = await done;
  if ("error" in settled) {
    // A wedged Orb can also fail fast: its commands time out rather than
    // hang. Then the failure only means something if the Orb is silent.
    if (commandLost(settled.error) && !(await answersEither(guest)))
      return UNRESPONSIVE;
    throw settled.error;
  }
  return settled.value;
};

/** A setup command the guest lost or timed out, not one that failed. */
const commandLost = (cause: unknown) =>
  cause instanceof Error && cause.message.includes(":WORKSPACE_COMMAND_LOST)");

/** Whether either of `ORB_LIVENESS_MISSES` checks in a row is answered. */
const answersEither = async (guest: ExecutionGuest) => {
  for (let check = 0; check < ORB_LIVENESS_MISSES; check += 1)
    if (await answers(guest)) return true;
  return false;
};

/** The last automatic restart per Thread, in this isolate. */
const restartedAt = new Map<string, number>();

const utcTime = (at: number) =>
  `${new Date(at).toISOString().slice(11, 16)} UTC`;

/**
 * Prepares the Orb, restarting it once if it stops answering. `reopen`
 * opens the restarted Orb and makes it the activation's handle.
 */
export const prepareWhileOrbAnswers = async <Prepared>(input: {
  readonly provider: ExecutionProvider;
  readonly context: ExecutionContext;
  readonly threadId: ThreadId;
  /** A reconnect never restarts the Orb; only a run's activation does. */
  readonly existingOnly: boolean;
  readonly handle: ExecutionWorkspaceHandle;
  readonly prepare: (handle: ExecutionWorkspaceHandle) => Promise<Prepared>;
  readonly reopen: () => Promise<ExecutionWorkspaceHandle>;
}): Promise<Prepared> => {
  const { provider, context, threadId } = input;
  const first = await whileAnswering(
    input.handle.guest,
    input.prepare(input.handle),
  );
  if (first !== UNRESPONSIVE) return first;
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    executionWorkspaceLogger.error("The Orb stopped responding.", {
      event: "workspace_unresponsive",
      threadId,
      provider: context.profile.adapter,
      outcome,
      ...extra,
    });
  if (input.existingOnly) {
    log("reconnect");
    throw unresponsiveRunError(
      "dx restarts it when the Thread's next turn starts.",
    );
  }
  const recover = provider.workspace.recover;
  if (recover === undefined) {
    log("unsupported");
    throw unresponsiveRunError(
      `dx can't restart this Orb automatically. Stop heavy processes from the Terminal if it answers. ${MANUAL_RESTART}`,
    );
  }
  const now = Date.now();
  const previous = restartedAt.get(threadId);
  if (previous !== undefined && now - previous < ORB_RESTART_WINDOW_MS) {
    log("recently_restarted", { restartedAt: previous });
    throw unresponsiveRunError(
      `dx already restarted it at ${utcTime(previous)}, less than ${ORB_RESTART_WINDOW_MS / 60_000} minutes ago, and it stopped responding again. Something in it, such as a heavy test run or a service it starts, is likely overloading it. ${MANUAL_RESTART}`,
    );
  }
  executionWorkspaceLogger.warn("The Orb stopped responding; restarting it.", {
    event: "workspace_unresponsive",
    threadId,
    provider: context.profile.adapter,
    outcome: "recovering",
  });
  let recovery: ExecutionWorkspaceRecovery;
  try {
    recovery = await recover.call(
      provider.workspace,
      context,
      { threadId },
      { discardUnsaved: false },
    );
  } catch (cause) {
    log("recovery_failed", {
      error: cause instanceof Error ? cause.message.slice(0, 500) : "failed",
    });
    throw unresponsiveRunError(
      `dx tried to restart the Orb, but the restart failed. Retry to try again. ${MANUAL_RESTART}`,
    );
  }
  if (recovery.files === "unsaved") {
    log("unsaved");
    throw unresponsiveRunError(
      "dx didn't restart the Orb: it couldn't save its files first, and a restart would lose them. Wait for heavy processes in it to finish, then retry.",
    );
  }
  restartedAt.set(threadId, now);
  const restarted = await input.reopen();
  const again = await whileAnswering(restarted.guest, input.prepare(restarted));
  if (again === UNRESPONSIVE) {
    log("still_unresponsive", { files: recovery.files });
    throw unresponsiveRunError(
      `dx restarted the Orb, keeping its files, but it still isn't responding. ${MANUAL_RESTART}`,
    );
  }
  executionWorkspaceLogger.info(
    "The Orb was restarted after it stopped responding.",
    {
      event: "workspace_unresponsive",
      threadId,
      outcome: "recovered",
      files: recovery.files,
    },
  );
  rememberWorkspaceRecovery(threadId, { ...recovery, cause: "unresponsive" });
  return again;
};
