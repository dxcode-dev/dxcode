import {
  THREAD_TITLE_MAX_LENGTH,
  type ThreadId,
  type ThreadModelSelection,
  type UserId,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { threadPersistenceLogger } from "../logging.js";
import { publishRealtimeInvalidation } from "../realtime/publication.js";

/**
 * DxTitleAgent: a single tool-free model call that replaces a new thread's
 * deterministic title. It is not a Flue agent and has no route, conversation,
 * or Durable Object of its own; the thread's credential coordinator runs the
 * call on the thread's current model with low thinking. Clients show a
 * loading title meanwhile; any failure reveals the deterministic title.
 */
export const DX_TITLE_AGENT_SYSTEM_PROMPT = `You are an assistant that generates short, descriptive titles (maximum 3 words, "Sentence case" with the first word capitalized not "Title Case") based on the first user message in an agentic coding tool thread. Your title should be concise (max 3 words) and capture the user's stated goal without guessing beyond the message. Omit generic words like "question", "request", etc. Be professional and precise. Use common software engineering terms and acronyms if they are helpful. The source material is enclosed in <user_message> tags and, when available, <agent_response> tags. Use only that tagged material to determine the title, and do not include the tags in your answer. Make the title information-dense like a strong commit subject: name the concrete component and change, problem, or goal. Titles should usually be noun phrases. Avoid generic leading verbs such as "Implement", "Clarify", "Improve", or "Find" when the nouns communicate the topic better. Do not add source-control prefixes such as "feat:", "fix:", "chore:", or "refactor:". Never include opaque identifiers such as bug IDs, thread IDs, commit hashes, or URLs. Follow title naming conventions explicitly stated in the supplied messages. Preserve only a requested prefix such as "BUG:"; the prefix counts toward the word limit. When a message requests work on a bug but provides no descriptive details beyond an opaque identifier, use "BUG: Investigation" until more context is available. Always render the dx product brand name as "dx", never "DX". Examples: "Fix OAuth callback retries when refresh tokens expire" becomes "OAuth refresh retries"; "Reduce SQLite actor wake latency" becomes "SQLite wake latency"; "BUG: Pasting multiple images fails on iOS" becomes "BUG: iOS paste"; "Fix dx_bug_…" becomes "BUG: Investigation". Use minimal reasoning and respond before the 2,048-token output limit. Respond with only the title and no other text.`;

export const DX_TITLE_AGENT_MAX_OUTPUT_TOKENS = 2_048;
const MESSAGE_CHARACTER_LIMIT = 4_000;
// The prompt asks for 3 words; allow slight overflow (GLM answered
// "BUG: iOS multi-image paste"), but reject prose such as refusals.
const MAX_TITLE_WORDS = 5;
// Inside the 30 s `waitUntil` budget; Workers AI GLM took 18 s at low effort.
const REQUEST_TIMEOUT_MS = 28_000;

/** The first message, bounded and wrapped for the title prompt. */
export const titleUserMessage = (body: string): string | undefined => {
  const trimmed = body.trim();
  if (trimmed === "") return undefined;
  const bounded = [...trimmed].slice(0, MESSAGE_CHARACTER_LIMIT).join("");
  return `<user_message>\n${bounded}\n</user_message>`;
};

/** Accept only a bare title within the prompt's limits. */
export const sanitizeGeneratedTitle = (raw: string): string | undefined => {
  const line = raw
    .replace(/<\/?[A-Za-z_]+>/g, "")
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  if (line === undefined) return undefined;
  const title = line
    .replace(/^["'`*_]+|["'`*_.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    title === "" ||
    title.split(" ").length > MAX_TITLE_WORDS ||
    title.length > THREAD_TITLE_MAX_LENGTH
  )
    return undefined;
  return title;
};

export interface DxTitleAgentJob {
  readonly threadId: ThreadId;
  readonly ownerUserId: UserId;
  readonly selection: ThreadModelSelection;
  readonly message: string;
  /** Settles true once the Thread row exists, false if creation failed. */
  readonly persisted: Promise<boolean>;
}

export type DxTitleAgentRunner = (
  bindings: Bindings,
  job: DxTitleAgentJob,
) => Promise<void>;

/**
 * Whether a new Thread gets a generated title. Only then is its title stored
 * as pending; routine local development never makes billable model calls.
 */
export const dxTitleAgentApplies = (bindings: Bindings, message: string) =>
  bindings.DX_RUNTIME_MODE !== "local" &&
  bindings.BYOK_CREDENTIAL_COORDINATOR !== undefined &&
  bindings.DB !== undefined &&
  titleUserMessage(message) !== undefined;

/** Model call and sanitation; undefined keeps the stored fallback title. */
const generateTitle = async (
  coordinator: DurableObjectNamespace,
  job: DxTitleAgentJob,
  message: string,
): Promise<string | undefined> => {
  const response = await coordinator
    .get(coordinator.idFromName(`byok-${job.threadId}`))
    .fetch("https://dx-byok.invalid/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: job.threadId,
        ownerUserId: job.ownerUserId,
        selection: job.selection,
        systemPrompt: DX_TITLE_AGENT_SYSTEM_PROMPT,
        message,
        maxTokens: DX_TITLE_AGENT_MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  if (!response.ok) {
    const { code } = await response
      .json<{ code?: string }>()
      .catch(() => ({ code: undefined }));
    threadPersistenceLogger.warn("Thread title generation failed.", {
      event: "thread_title_generation_failed",
      threadId: job.threadId,
      code: code ?? `HTTP_${response.status}`,
    });
    return undefined;
  }
  const { text } = await response.json<{ text: string }>();
  const title = sanitizeGeneratedTitle(text);
  if (title === undefined)
    threadPersistenceLogger.warn("Thread title generation was unusable.", {
      event: "thread_title_generation_failed",
      threadId: job.threadId,
      code: "UNUSABLE_TITLE",
    });
  return title;
};

/**
 * Never rejects. Ends the pending state either way: a generated title
 * replaces the stored fallback, and any failure reveals the fallback. The
 * title is kept even when the first message is later not admitted.
 */
export const runDxTitleAgent: DxTitleAgentRunner = async (bindings, job) => {
  const coordinator = bindings.BYOK_CREDENTIAL_COORDINATOR;
  const db = bindings.DB;
  const message = titleUserMessage(job.message);
  if (
    !dxTitleAgentApplies(bindings, job.message) ||
    coordinator === undefined ||
    db === undefined ||
    message === undefined
  )
    return;
  // The model call starts now, while the Thread is still being created; the
  // row is needed only to store the result.
  const [title, persisted] = await Promise.all([
    generateTitle(coordinator, job, message).catch((error: unknown) => {
      threadPersistenceLogger.warn("Thread title generation failed.", {
        event: "thread_title_generation_failed",
        threadId: job.threadId,
        code: error instanceof Error ? error.name : "UNKNOWN",
      });
      return undefined;
    }),
    job.persisted,
  ]);
  if (!persisted) return;
  try {
    const statement =
      title === undefined
        ? db
            .prepare(
              `UPDATE threads SET title_pending_until = NULL
                WHERE id = ? AND title_pending_until IS NOT NULL`,
            )
            .bind(job.threadId)
        : db
            .prepare(
              `UPDATE threads SET title = ?, title_pending_until = NULL
                WHERE id = ? AND title_pending_until IS NOT NULL`,
            )
            .bind(title, job.threadId);
    const result = await statement.run();
    if (result.meta.changes > 0)
      await publishRealtimeInvalidation(
        bindings,
        job.threadId,
        "thread.invalidated",
      );
  } catch (error) {
    threadPersistenceLogger.warn("Thread title persistence failed.", {
      event: "thread_title_persistence_failed",
      threadId: job.threadId,
      code: error instanceof Error ? error.name : "UNKNOWN",
    });
  }
};
