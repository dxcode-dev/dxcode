import type { SandboxFactory } from "@flue/runtime";

type Sandbox = Awaited<ReturnType<SandboxFactory["createSandbox"]>>;

/**
 * The Thread's workspace for dx's own files outside the repository, such as
 * the skills under `~/.local/share/dx`. Its commands keep Thread
 * authorization and the Orb's activity lease but skip Changes coordination:
 * they cannot change the repository, and each coordinated command costs
 * several D1 round trips before the turn's first model request.
 *
 * Activation sets it for the turn it starts; the agent-start hook takes it
 * once, so a turn without an activation of its own never gets a stale one.
 */
const sandboxes = new Map<string, Sandbox>();

export const rememberDxFilesSandbox = (threadId: string, sandbox: Sandbox) => {
  sandboxes.set(threadId, sandbox);
};

export const takeDxFilesSandbox = (threadId: string): Sandbox | undefined => {
  const sandbox = sandboxes.get(threadId);
  sandboxes.delete(threadId);
  return sandbox;
};
