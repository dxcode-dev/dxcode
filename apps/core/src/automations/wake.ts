import {
  isClaudeCodeModel,
  type ThreadModelSelection,
  type UserId,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { loadThreadClaudePlan } from "../settings/model-routing/connection-store-d1.js";
import {
  agentModeSelection,
  idempotentThreadId,
  sha256Hex,
} from "../threads/agent-tools.js";
import { ownerRequest } from "../threads/owner-request.js";

/**
 * How work after a turn starts. A dx run ends with its turn, in dx mode and
 * in Claude Code mode alike, so nothing waits in the workspace: a schedule or
 * a GitHub event wakes a Thread the same way `send_thread_message` does, by
 * delivering a user message through the owner's own agent route. Flue admits
 * it as a new turn (or steers a running one), DxAgent resolves the Thread's
 * model, and a Claude Code Thread resumes its Claude session. The message's
 * author tag carries `automation`, so the agent and the transcript know it
 * did not come from a person.
 *
 * Every delivery has an idempotency key derived from what fired, so a sweep
 * that runs twice delivers once.
 */

export interface WakeTarget {
  readonly bindings: Bindings;
  readonly ownerUserId: string;
  readonly automation: "schedule" | "github";
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

const failure = (
  operation: string,
  status: number,
  payload: Record<string, unknown> | undefined,
) => {
  const detail = (payload?.data ?? payload?.error) as
    | { code?: string; type?: string; message?: string }
    | undefined;
  return new Error(
    `${operation} failed: ${detail?.code ?? detail?.type ?? status}${
      detail?.message === undefined ? "" : ` (${detail.message})`
    }`,
  );
};

/** Delivers a message to an existing Thread; returns its submission. */
export const deliverMessage = async (
  target: WakeTarget,
  threadId: string,
  body: string,
  key: string,
) => {
  const { response, payload } = await ownerRequest(
    {
      bindings: target.bindings,
      ownerUserId: target.ownerUserId as UserId,
      automation: target.automation,
      ...(target.waitUntil === undefined
        ? {}
        : { waitUntil: target.waitUntil }),
    },
    "POST",
    `/v1/agents/dx/${encodeURIComponent(threadId)}`,
    { kind: "user", body, idempotencyKey: await sha256Hex(key) },
  );
  const submissionId = payload?.submissionId;
  if (response.status !== 202 || typeof submissionId !== "string")
    throw failure("Delivering the message", response.status, payload);
  return submissionId;
};

/**
 * The selection a new Thread runs: the agent mode the automation saved, or
 * the selection of the Thread it belongs to.
 */
export const selectionFor = async (
  db: D1Database,
  threadId: string,
  agentMode: string | null,
) => {
  const stored = await db
    .prepare("SELECT model_selection FROM threads WHERE id = ?")
    .bind(threadId)
    .first<string>("model_selection");
  let selection: ThreadModelSelection | undefined;
  try {
    selection =
      stored === null
        ? undefined
        : (JSON.parse(stored) as ThreadModelSelection);
  } catch {
    selection = undefined;
  }
  return agentMode === null
    ? selection
    : agentModeSelection(agentMode, selection);
};

/**
 * Starts a child Thread of `parentThreadId` with a first message. The key
 * names the Thread, so a repeated sweep finds the one it started.
 */
export const startThread = async (
  target: WakeTarget,
  input: {
    readonly parentThreadId: string;
    readonly projectId?: string;
    readonly title: string;
    readonly prompt: string;
    readonly selection: ThreadModelSelection | undefined;
    readonly key: string;
  },
) => {
  const threadId = await idempotentThreadId(input.key);
  // No one picks a plan here: a Claude Code Thread an automation starts runs
  // on its parent's plan.
  const claudeConnectionId =
    input.selection?.kind === "model" &&
    isClaudeCodeModel(input.selection.model) &&
    target.bindings.DB !== undefined
      ? (await loadThreadClaudePlan(target.bindings.DB, input.parentThreadId))
          .connectionId
      : undefined;
  const { response, payload } = await ownerRequest(
    {
      bindings: target.bindings,
      ownerUserId: target.ownerUserId as UserId,
      automation: target.automation,
      ...(target.waitUntil === undefined
        ? {}
        : { waitUntil: target.waitUntil }),
    },
    "POST",
    "/v1/threads",
    {
      threadId,
      parentThreadId: input.parentThreadId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      title: input.title.slice(0, 256),
      generateTitle: false,
      ...(input.selection === undefined ? {} : { selection: input.selection }),
      ...(claudeConnectionId === undefined ? {} : { claudeConnectionId }),
      initialMessage: { body: input.prompt, attachments: [] },
    },
  );
  const created = payload?.data as { readonly id?: string } | undefined;
  // A repeated start answers with the Thread the first one created.
  if (!response.ok || created?.id === undefined)
    throw failure("Starting a Thread", response.status, payload);
  return created.id;
};
