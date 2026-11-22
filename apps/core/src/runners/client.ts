import type { Bindings } from "../http/types.js";
import { type RunnerOperation, RunnerOperationError } from "./protocol.js";
import type { RunnerStatus } from "./session-object.js";

const session = (bindings: Bindings, machineId: string) => {
  const namespace = bindings.RUNNER_SESSION;
  if (namespace === undefined)
    throw new RunnerOperationError("offline", "Runners are not installed.");
  return namespace.get(namespace.idFromName(machineId));
};

/**
 * Runs one workspace operation for a Thread on its machine. Throws
 * {@link RunnerOperationError} with the runner's code.
 */
export const runnerCall = async <Result>(
  bindings: Bindings,
  machineId: string,
  op: RunnerOperation,
  threadId: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Result> => {
  try {
    return (await session(bindings, machineId).call(
      op,
      threadId,
      body,
      timeoutMs,
    )) as Result;
  } catch (cause) {
    const error = RunnerOperationError.from(cause);
    // Unreachable because it was removed, not asleep: say so, since no
    // wake brings it back.
    if (error.code === "offline" && (await machineRemoved(bindings, machineId)))
      throw new RunnerOperationError(
        "removed",
        "This Thread's runner was removed in Settings › Runners.",
      );
    throw error;
  }
};

const machineRemoved = async (bindings: Bindings, machineId: string) => {
  if (bindings.DB === undefined) return false;
  try {
    const row = await bindings.DB.prepare(
      "SELECT revoked_at FROM runner_machine WHERE id = ?",
    )
      .bind(machineId)
      .first<{ revoked_at: number | null }>();
    return row === null || row.revoked_at !== null;
  } catch {
    return false;
  }
};

export const runnerStatus = async (
  bindings: Bindings,
  machineId: string,
): Promise<RunnerStatus | undefined> => {
  try {
    return await session(bindings, machineId).status();
  } catch {
    return undefined;
  }
};

export const revokeRunnerSession = async (
  bindings: Bindings,
  machineId: string,
) => {
  try {
    await session(bindings, machineId).revoke();
  } catch {
    // An object that cannot be reached has no connection to close.
  }
};
