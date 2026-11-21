import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import { answerReadsWhileFirstMessagePending } from "../threads/initial-dispatch-delivery.js";
import { useAgentAdmission } from "./admission.js";
import { DxAgent } from "./dx-agent.js";

/**
 * DxAgent's native Flue routes behind dx's Thread admission, mounted at
 * `/v1/agents/dx` after authentication. The Thread tools send messages and
 * read history through these same routes as the Thread owner.
 */
const flue = createAgentRouter(DxAgent);
export const dxAgentRoutes = useAgentAdmission(new Hono<AppEnv>());
// A new Thread's first read may come before its agent has the first
// message; it is answered once the agent has it, never with a 404.
const pendingReads = answerReadsWhileFirstMessagePending(flue);
dxAgentRoutes.use("/:threadId", pendingReads);
dxAgentRoutes.use("/:threadId/:subpath{.+}", pendingReads);
dxAgentRoutes.route("/", flue);

/**
 * Ends a Thread's running turn and every message queued behind it, as Stop
 * does. It bypasses admission: archiving calls it once the Thread is
 * archived, when admission refuses Stop, for the owner it already
 * authorized (#1668).
 */
export const stopThreadAgent = async (threadId: string, env: Bindings) => {
  const response = await flue.request(
    `/${encodeURIComponent(threadId)}/abort`,
    { method: "POST" },
    env,
  );
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(`Stopping the Thread's agent failed (${response.status}).`);
};

/**
 * Rewinds a Thread's agent to just before one of its user messages, so an
 * edited message can replace it. It bypasses admission: the message edit
 * route authorizes the editor and checks the sender first. Answers Flue's
 * response: 409 while a turn or queued message has not settled, 400 when
 * the message is not in the current history or no longer has `expectText`.
 */
export const rewindThreadAgent = (
  threadId: string,
  input: {
    readonly entryId: string;
    readonly idempotencyKey: string;
    readonly expectText: string;
  },
  env: Bindings,
) =>
  flue.request(
    `/${encodeURIComponent(threadId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "rewind", ...input }),
    },
    env,
  );

/** Flue's answer to withdrawing a queued message. */
export type WithdrawThreadMessageResult =
  | { readonly withdrawn: true }
  /** The agent took it already: `entryId` names it in the history. */
  | {
      readonly withdrawn: false;
      readonly status: string;
      readonly entryId: string;
    }
  | { readonly withdrawn: false; readonly status: "absent" }
  /** Still queued, but not with the text the caller checked. */
  | { readonly withdrawn: false; readonly status: "queued" };

/**
 * Takes a message out of the Thread's queue before the agent reads it:
 * Flue settles the submission aborted only while it is still queued, in the
 * same Durable Object that claims queued messages, so exactly one of the
 * withdraw and the agent's pickup wins. It bypasses admission: the caller
 * checks who sent the message first (`listQueuedThreadMessages`) and passes
 * the text it checked as `expectBody`; Flue changes nothing when the queued
 * message holds another.
 */
export const withdrawThreadMessage = async (
  threadId: string,
  submissionId: string,
  expectBody: string,
  env: Bindings,
): Promise<WithdrawThreadMessageResult> => {
  const response = await flue.request(
    `/${encodeURIComponent(threadId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "withdraw", submissionId, expectBody }),
    },
    env,
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return { withdrawn: false, status: "absent" };
  }
  if (response.status !== 200 && response.status !== 409) {
    await response.body?.cancel();
    throw new Error(
      `Withdrawing a queued message failed (${response.status}).`,
    );
  }
  return (await response.json()) as WithdrawThreadMessageResult;
};

/** Flue's answer to replacing a queued message's text. */
export type ReplaceThreadMessageResult =
  | { readonly replaced: true }
  | {
      readonly replaced: false;
      readonly status: string;
      readonly entryId: string;
    }
  | { readonly replaced: false; readonly status: "absent" }
  | { readonly replaced: false; readonly status: "queued" };

/**
 * Replaces a queued message's text in place, keeping its submission and its
 * place in the queue, only while it is still queued with `expectBody`: the
 * same compare-and-set the agent's pickup races, so exactly one wins.
 */
export const replaceQueuedThreadMessage = async (
  threadId: string,
  submissionId: string,
  expectBody: string,
  body: string,
  env: Bindings,
): Promise<ReplaceThreadMessageResult> => {
  const response = await flue.request(
    `/${encodeURIComponent(threadId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "replace", submissionId, expectBody, body }),
    },
    env,
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return { replaced: false, status: "absent" };
  }
  if (response.status !== 200 && response.status !== 409) {
    await response.body?.cancel();
    throw new Error(`Replacing a queued message failed (${response.status}).`);
  }
  return (await response.json()) as ReplaceThreadMessageResult;
};

/** A message in the Thread's queue, as Flue holds it (author tag included). */
export interface QueuedThreadMessage {
  readonly submissionId: string;
  readonly body: string;
  readonly acceptedAt: string;
}

/**
 * The messages waiting in the Thread's queue for the agent to read them, in
 * the order it will. It bypasses admission: callers authorize the Thread
 * and show each person only their own.
 */
export const listQueuedThreadMessages = async (
  threadId: string,
  env: Bindings,
): Promise<ReadonlyArray<QueuedThreadMessage>> => {
  const response = await flue.request(
    `/${encodeURIComponent(threadId)}?view=queued`,
    { method: "GET" },
    env,
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return [];
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Reading the Thread's queued messages failed (${response.status}).`,
    );
  }
  const { submissions } = (await response.json()) as {
    readonly submissions: ReadonlyArray<QueuedThreadMessage>;
  };
  return submissions;
};
