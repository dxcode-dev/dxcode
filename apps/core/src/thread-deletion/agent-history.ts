import type { ThreadId } from "@dx/domain";
import type { Bindings } from "../http/types.js";

/** The Agents SDK methods the Thread's Flue agent object answers over RPC. */
interface AgentObjectStub {
  readonly setName: (name: string) => Promise<void>;
  readonly destroy: () => Promise<void>;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Erases the Thread's conversation: its Flue agent object holds the history,
 * submissions, streams, and message files in its own SQLite. The Agents SDK's
 * `destroy` drops those tables, the alarm, and every stored key, then resets
 * the object. Flue reports an agent only while its initial data is stored,
 * so the history is gone once Flue no longer finds an agent for the Thread.
 */
export const eraseAgentHistory = async (
  bindings: Pick<Bindings, "FLUE_DX_AGENT_AGENT">,
  threadId: ThreadId,
): Promise<void> => {
  const namespace = bindings.FLUE_DX_AGENT_AGENT;
  if (namespace === undefined)
    throw new Error("The Flue agent binding is unavailable.");
  const stub = namespace.get(
    namespace.idFromName(threadId),
  ) as unknown as AgentObjectStub;
  await stub.setName(threadId);
  // The object resets itself right after wiping, which can surface to this
  // caller as an error even though the wipe finished; the check decides.
  await stub.destroy().catch(() => undefined);
  // Loaded here so the cron entry does not load the agent and its skills.
  const [{ getAgentInstance }, { DxAgent }] = await Promise.all([
    import("@flue/runtime"),
    import("../agents/dx-agent.js"),
  ]);
  for (const delay of [0, 250, 1_000]) {
    await pause(delay);
    const instance = await getAgentInstance(DxAgent, threadId).catch(
      () => undefined,
    );
    if (instance === null) return;
  }
  throw new Error("The Thread's agent history is still present.");
};
