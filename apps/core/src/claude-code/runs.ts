import type { Sandbox } from "@flue/runtime";
import {
  ClaudeCodeRun,
  claudeCodeAttemptKey,
  claudeCodeAttemptNumber,
  claudeCodeRunsRoot,
} from "./workspace-run.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const hasToolCall = (run: ClaudeCodeRun, toolCallId: string) =>
  run.stream.toolResults.has(toolCallId) ||
  run.stream.segments.some(({ blocks }) =>
    blocks.some(
      (block) => block.type === "toolCall" && block.id === toolCallId,
    ),
  );

/** The attempt directory of a chunk path, guest or local-runtime host path. */
const attemptOfChunk = (path: string) =>
  /\/dx-claude-code\/runs\/([^/]+)\/c\d{6}$/.exec(path)?.[1];

/**
 * Attempts this isolate is reading, so the model stream and the mirror tools
 * share one reader per attempt. After a Durable Object restart an attempt is
 * found again in the workspace and re-read from its first chunk. An isolate
 * may host several Threads, so every attempt is keyed by its Thread.
 */
class ClaudeCodeRuns {
  /** Attempts by Thread, then by attempt key. */
  readonly #threads = new Map<string, Map<string, ClaudeCodeRun>>();

  #runs(threadId: string) {
    let runs = this.#threads.get(threadId);
    if (runs === undefined) {
      runs = new Map();
      this.#threads.set(threadId, runs);
    }
    return runs;
  }

  #open(threadId: string, key: string, sandbox: Sandbox, base?: number) {
    const runs = this.#runs(threadId);
    let run = runs.get(key);
    if (run === undefined) {
      run = new ClaudeCodeRun(key, sandbox, base);
      runs.set(key, run);
    }
    return run;
  }

  /**
   * A new attempt of `turn`, starting at the turn's Flue segment `base`.
   * Finished attempts of earlier turns leave memory; their files stay.
   */
  create(
    threadId: string,
    turn: string,
    attempt: number,
    base: number,
    sandbox: Sandbox,
  ) {
    const runs = this.#runs(threadId);
    for (const [key, run] of runs)
      if (claudeCodeAttemptNumber(turn, key) === undefined && run.exited)
        runs.delete(key);
    return this.#open(
      threadId,
      claudeCodeAttemptKey(turn, attempt),
      sandbox,
      base,
    );
  }

  /** The turn's attempts, oldest first, including ones only on disk. */
  async attempts(threadId: string, turn: string, sandbox: Sandbox) {
    const names = await sandbox.readdir(claudeCodeRunsRoot).catch(() => []);
    const numbers = new Set<number>();
    for (const name of names) {
      const attempt = claudeCodeAttemptNumber(turn, name);
      if (attempt !== undefined) numbers.add(attempt);
    }
    for (const key of this.#runs(threadId).keys()) {
      const attempt = claudeCodeAttemptNumber(turn, key);
      if (attempt !== undefined) numbers.add(attempt);
    }
    return [...numbers]
      .sort((left, right) => left - right)
      .map((attempt) => ({
        attempt,
        run: this.#open(threadId, claudeCodeAttemptKey(turn, attempt), sandbox),
      }));
  }

  async forToolCall(
    threadId: string,
    toolCallId: string,
    sandbox: Sandbox,
    signal?: AbortSignal,
  ) {
    for (const run of this.#runs(threadId).values())
      if (hasToolCall(run, toolCallId)) return run;
    if (!/^[A-Za-z0-9_-]+$/.test(toolCallId)) return undefined;
    const found = await sandbox
      .exec(
        `bash -c ${quote(`grep -l -F -- ${quote(toolCallId)} ${quote(claudeCodeRunsRoot)}/*/c* 2>/dev/null | head -n 1`)}`,
        { timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) },
      )
      .catch(() => undefined);
    const key = attemptOfChunk(found?.stdout.trim() ?? "");
    if (key === undefined) return undefined;
    const run = this.#open(threadId, key, sandbox);
    await run.waitFor(() => hasToolCall(run, toolCallId), signal);
    return hasToolCall(run, toolCallId) ? run : undefined;
  }
}

export const claudeCodeRuns = new ClaudeCodeRuns();

/**
 * The agent's live workspace sandbox per Thread, recorded when a delivered
 * message starts work. A model call after a Durable Object restart, before
 * any delivery runs again, reconnects through the execution factory.
 */
const sandboxes = new Map<string, Promise<Sandbox>>();

export const rememberClaudeCodeSandbox = (
  threadId: string,
  sandbox: Sandbox,
) => {
  sandboxes.set(threadId, Promise.resolve(sandbox));
};

export const claudeCodeSandbox = (
  threadId: string,
  reconnect: () => Promise<Sandbox>,
) => {
  let sandbox = sandboxes.get(threadId);
  if (sandbox === undefined) {
    sandbox = reconnect().catch((error: unknown) => {
      sandboxes.delete(threadId);
      throw error;
    });
    sandboxes.set(threadId, sandbox);
  }
  return sandbox;
};
