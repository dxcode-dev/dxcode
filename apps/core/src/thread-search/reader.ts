import { parseMessageAuthor, stripMessageAuthorTags } from "@dx/api";
import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import {
  finalReplyText,
  type HistoryPage,
  type HistoryPart,
  INDEXED_MESSAGE_MAX_CHARS,
} from "./history.js";
import {
  CURRENT_CONTEXT_SYSTEM_PROMPT,
  READ_MESSAGES_DESCRIPTION,
  SEARCH_MESSAGES_DESCRIPTION,
  THREAD_READER_SYSTEM_PROMPT,
} from "./reader-prompt.js";
import { auxTerms, isPlainTerm, queryTerms } from "./terms.js";

/**
 * The reader `read_thread` runs: a model loop over one Thread's whole
 * history, loaded once per call, with `search_messages` and `read_messages`
 * over normalized messages. Nothing here reads the search index, so a read
 * costs one history read and the model's tokens.
 *
 * Flue's history merges each agent response into one message; the reader
 * sees it split the way a model produced it: an assistant message per step
 * holding its text, reasoning, and tool calls, followed by one `tool_result`
 * message holding that step's results.
 */

/** One `read_messages` response holds about this much JSON. */
const RESPONSE_MAX_CHARS = 40_000;
/** A search hit carries a whole message up to this size, else a prefix. */
const SEARCH_HIT_MAX_BYTES = 8_192;
/** One `search_messages` response holds about this much JSON of hits. */
const SEARCH_RESPONSE_MAX_BYTES = 24_576;
/** The reader's tool calls per `read_thread` call. */
export const READER_MAX_TOOL_CALLS = 40;
/** `current` sends about this much JSON of the newest messages. */
const CURRENT_MAX_CHARS = 120_000;
const SEARCH_DEFAULT_LIMIT = 20;

type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "attachment" }
  | {
      readonly type: "tool_call";
      readonly toolUseId: string;
      readonly name: string;
      readonly status: "done" | "error" | "in-progress";
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly toolName: string;
      readonly status: "done" | "error";
      readonly result?: unknown;
      readonly error?: string;
    };

/** One message as the reader sees it. */
export interface NormalizedMessage {
  readonly index: number;
  readonly role: "user" | "assistant" | "info";
  /**
   * User messages only: `human` is a person, `thread` another thread's
   * agent (sent with a Thread tool), `tool_result` the results of the
   * preceding assistant message's tool calls.
   */
  readonly origin?: "human" | "thread" | "tool_result";
  /** The person who sent a human message. */
  readonly fromUserID?: string;
  /** The thread whose agent sent a cross-thread message. */
  readonly fromThreadID?: string;
  readonly sender?: Readonly<Record<string, string>>;
  /** People talking to each other in a shared thread, not to the agent. */
  readonly chat?: true;
  /** Assistant messages of a turn that has not finished, or did not succeed. */
  readonly status?: "streaming" | "errored" | "cancelled";
  readonly timestamp?: string;
  readonly blocks: ReadonlyArray<Block>;
}

interface Normalized {
  readonly messages: ReadonlyArray<NormalizedMessage>;
  /** Searchable text per message index: people's messages and final replies. */
  readonly searchable: ReadonlyMap<number, string>;
}

const toolStatus = (part: HistoryPart) =>
  part.state === "output-error"
    ? ("error" as const)
    : part.state === "output-available"
      ? ("done" as const)
      : ("in-progress" as const);

/** Splits Flue's merged history into the reader's numbered messages. */
export const normalizeHistory = (page: HistoryPage): Normalized => {
  const messages: NormalizedMessage[] = [];
  const searchable = new Map<number, string>();
  const push = (message: Omit<NormalizedMessage, "index">) => {
    messages.push({ index: messages.length + 1, ...message });
    return messages.length;
  };
  for (const message of page.messages) {
    const parts = message.parts ?? [];
    const timestamp =
      message.timestamp === undefined ? {} : { timestamp: message.timestamp };
    if (message.role === "user") {
      const raw = parts
        .flatMap(({ type, text }) => (type === "text" && text ? [text] : []))
        .join("\n");
      const { author, sourceThreadId } = parseMessageAuthor(raw);
      const text = stripMessageAuthorTags(raw).trim();
      const index = push({
        role: "user",
        ...(sourceThreadId === undefined
          ? {
              origin: "human" as const,
              ...(author === undefined ? {} : { fromUserID: author.userId }),
            }
          : { origin: "thread" as const, fromThreadID: sourceThreadId }),
        ...(author === undefined
          ? {}
          : {
              sender: {
                name: author.name,
                role: author.role,
                ...(author.handle === undefined
                  ? {}
                  : { handle: author.handle }),
              },
            }),
        ...(message.purpose === "chat" ? { chat: true as const } : {}),
        ...timestamp,
        blocks: [
          ...(text === "" ? [] : [{ type: "text" as const, text }]),
          ...parts
            .filter(({ type }) => type === "file")
            .map(() => ({ type: "attachment" as const })),
        ],
      });
      if (text !== "")
        searchable.set(index, text.slice(0, INDEXED_MESSAGE_MAX_CHARS));
      continue;
    }
    if (message.role !== "assistant") {
      const text = parts
        .flatMap(({ type, text }) => (type === "text" && text ? [text] : []))
        .join("\n")
        .trim();
      push({
        role: "info",
        ...timestamp,
        blocks: text === "" ? [] : [{ type: "text", text }],
      });
      continue;
    }
    // One assistant step per run of text and tool calls; its results follow.
    const outcome =
      message.submissionId === undefined
        ? undefined
        : page.settled.get(message.submissionId);
    const turnStatus =
      outcome === undefined
        ? ({ status: "streaming" } as const)
        : outcome === "failed"
          ? ({ status: "errored" } as const)
          : outcome === "aborted"
            ? ({ status: "cancelled" } as const)
            : {};
    let step: Block[] = [];
    let results: Block[] = [];
    let stepIndex = 0;
    const flush = () => {
      if (step.length > 0)
        stepIndex = push({
          role: "assistant",
          ...turnStatus,
          ...timestamp,
          blocks: step,
        });
      if (results.length > 0)
        push({
          role: "user",
          origin: "tool_result",
          ...timestamp,
          blocks: results,
        });
      step = [];
      results = [];
    };
    for (const part of parts) {
      if (part.type === "dynamic-tool") {
        const toolUseId = part.toolCallId ?? `call_${step.length}`;
        const status = toolStatus(part);
        step.push({
          type: "tool_call",
          toolUseId,
          name: part.toolName ?? "unknown",
          status,
          input: part.input ?? {},
        });
        if (status !== "in-progress")
          results.push({
            type: "tool_result",
            toolUseId,
            toolName: part.toolName ?? "unknown",
            status,
            ...(status === "error"
              ? { error: part.errorText ?? "" }
              : { result: part.output ?? null }),
          });
        continue;
      }
      // Text after this step's tool calls starts the next step.
      if (results.length > 0 || step.some(({ type }) => type === "tool_call"))
        flush();
      if (part.type === "text" && part.text?.trim())
        step.push({ type: "text", text: part.text });
      else if (part.type === "reasoning" && part.text?.trim())
        step.push({ type: "thinking", text: part.text });
    }
    const finalStep =
      step.length > 0 && !step.some(({ type }) => type === "tool_call");
    flush();
    // The text that ends a settled turn is its final reply.
    if (
      finalStep &&
      message.purpose === "assistant" &&
      message.submissionId !== undefined &&
      page.settled.has(message.submissionId)
    ) {
      const text = finalReplyText(parts);
      if (text !== "")
        searchable.set(stepIndex, text.slice(0, INDEXED_MESSAGE_MAX_CHARS));
    }
  }
  return { messages, searchable };
};

/** A light stem, so `deploying` matches `deploys`, as the index's stemmer does. */
const stem = (word: string) => {
  for (const suffix of [
    "ations",
    "ation",
    "ingly",
    "edly",
    "ings",
    "ing",
    "ers",
    "ies",
    "er",
    "ed",
    "es",
    "ly",
    "s",
  ])
    if (word.endsWith(suffix) && word.length - suffix.length >= 3)
      return word.slice(0, -suffix.length);
  return word;
};

const words = (text: string) =>
  new Set(
    Array.from(text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu), ([word]) =>
      stem(word),
    ),
  );

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

type SearchHit =
  | { readonly index: number; readonly message: NormalizedMessage }
  | {
      readonly index: number;
      readonly jsonChunk: string;
      readonly truncated: true;
      readonly totalBytes: number;
    };

/** A whole message within its budget, else a JSON prefix of it. */
const searchHit = (message: NormalizedMessage): SearchHit => {
  const json = JSON.stringify(message);
  const totalBytes = byteLength(json);
  if (totalBytes <= SEARCH_HIT_MAX_BYTES)
    return { index: message.index, message };
  let prefix = json.slice(0, SEARCH_HIT_MAX_BYTES);
  while (byteLength(prefix) > SEARCH_HIT_MAX_BYTES)
    prefix = prefix.slice(0, -64);
  return {
    index: message.index,
    jsonChunk: prefix,
    truncated: true,
    totalBytes,
  };
};

/** Tool results are plain JSON; this also drops undefined fields. */
const jsonOutput = (value: unknown) => JSON.parse(JSON.stringify(value));

const cursorOf = (value: number) => btoa(String(value)).replace(/=+$/, "");
const fromCursor = (cursor: string) => {
  const value = Number(atob(cursor));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("The cursor is invalid; start a new read without it.");
  return value;
};

/** Splits one message's JSON into ordered chunks that fit a response. */
const chunksOf = (message: NormalizedMessage) => {
  const json = JSON.stringify(message);
  const chunks: string[] = [];
  for (let at = 0; at < json.length; at += RESPONSE_MAX_CHARS)
    chunks.push(json.slice(at, at + RESPONSE_MAX_CHARS));
  return chunks;
};

export interface LoadedThread {
  readonly threadId: string;
  readonly title: string;
  readonly page: HistoryPage;
}

export interface ReaderTools {
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly messageCount: number;
  /** Tool calls made so far. */
  readonly calls: () => number;
}

/** `search_messages` and `read_messages` over one loaded Thread. */
export const readerTools = (thread: LoadedThread): ReaderTools => {
  const { messages, searchable } = normalizeHistory(thread.page);
  const messageCount = messages.length;
  let calls = 0;
  const budget = () => {
    calls += 1;
    if (calls > READER_MAX_TOOL_CALLS)
      throw new Error(
        "The reading budget is spent. Answer now from what you have read.",
      );
  };

  const searchMessages = defineTool({
    name: "search_messages",
    description: SEARCH_MESSAGES_DESCRIPTION,
    input: v.object({
      query: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      role: v.optional(v.picklist(["user", "assistant"])),
      limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
      ),
      cursor: v.optional(v.pipe(v.string(), v.maxLength(64))),
    }),
    run: ({ data }) => {
      budget();
      const terms = queryTerms([data.query]);
      if (terms.length === 0) return { output: { messageCount, hits: [] } };
      const plain = terms.filter(isPlainTerm).map(stem);
      const compound = terms.filter((term) => !isPlainTerm(term));
      const limit = data.limit ?? SEARCH_DEFAULT_LIMIT;
      const below =
        data.cursor === undefined ? messageCount + 1 : fromCursor(data.cursor);
      const hits: SearchHit[] = [];
      let size = 0;
      let next: number | undefined;
      for (let index = below - 1; index >= 1; index--) {
        const text = searchable.get(index);
        const message = messages[index - 1];
        if (text === undefined || message === undefined) continue;
        if (data.role !== undefined && message.role !== data.role) continue;
        const present = words(text);
        if (!plain.every((term) => present.has(term))) continue;
        if (compound.length > 0) {
          const aux = new Set(auxTerms(text).split(" "));
          if (!compound.every((term) => aux.has(term))) continue;
        }
        const hit = searchHit(message);
        const length = byteLength(JSON.stringify(hit));
        if (
          hits.length === limit ||
          (hits.length > 0 && size + length > SEARCH_RESPONSE_MAX_BYTES)
        ) {
          next = hits.at(-1)?.index;
          break;
        }
        hits.push(hit);
        size += length;
      }
      return {
        output: jsonOutput({
          messageCount,
          hits,
          ...(next === undefined ? {} : { nextCursor: cursorOf(next) }),
        }),
      };
    },
  });

  const readMessages = defineTool({
    name: "read_messages",
    description: READ_MESSAGES_DESCRIPTION,
    input: v.object({
      start: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      end: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      cursor: v.optional(v.pipe(v.string(), v.maxLength(64))),
    }),
    run: ({ data }) => {
      budget();
      // A cursor encodes `index * 1000 + chunk` of where to continue.
      const position =
        data.cursor === undefined ? undefined : fromCursor(data.cursor);
      const start =
        position === undefined
          ? (data.start ?? 1)
          : Math.floor(position / 1000);
      let chunk = position === undefined ? 0 : position % 1000;
      const end =
        position === undefined
          ? Math.min(messageCount, data.end ?? start)
          : messageCount;
      const read: Array<
        | NormalizedMessage
        | {
            readonly index: number;
            readonly chunk: number;
            readonly chunkCount: number;
            readonly jsonChunk: string;
          }
      > = [];
      let size = 0;
      let next: number | undefined;
      for (let index = start; index <= end; index++) {
        const message = messages[index - 1];
        if (message === undefined) break;
        const length = JSON.stringify(message).length;
        if (chunk === 0 && length <= RESPONSE_MAX_CHARS) {
          if (read.length > 0 && size + length > RESPONSE_MAX_CHARS) {
            next = index * 1000;
            break;
          }
          read.push(message);
          size += length;
          continue;
        }
        if (read.length > 0) {
          next = index * 1000 + chunk;
          break;
        }
        const chunks = chunksOf(message);
        read.push({
          index,
          chunk,
          chunkCount: chunks.length,
          jsonChunk: chunks[chunk] ?? "",
        });
        next =
          chunk + 1 < chunks.length
            ? index * 1000 + chunk + 1
            : index < end
              ? (index + 1) * 1000
              : undefined;
        chunk = 0;
        break;
      }
      return {
        output: jsonOutput({
          messageCount,
          messages: read,
          ...(next === undefined ? {} : { nextCursor: cursorOf(next) }),
        }),
      };
    },
  });

  return {
    tools: [searchMessages, readMessages],
    messageCount,
    calls: () => calls,
  };
};

/**
 * `read_thread` in a Claude Code Thread, which has no reader model: one
 * page of the Thread's messages, newest first, each page about one
 * `read_messages` response. A message larger than a page comes alone, in
 * chunks. The cursor encodes `index * 1000 + chunk` of where to continue;
 * context "current" is the first page only.
 */
export const threadMaterialPage = (
  thread: LoadedThread,
  current: boolean,
  cursor?: string,
) => {
  const { messages } = normalizeHistory(thread.page);
  const messageCount = messages.length;
  const position =
    cursor === undefined ? messageCount * 1000 : fromCursor(cursor);
  let chunk = position % 1000;
  const read: Array<
    | NormalizedMessage
    | {
        readonly index: number;
        readonly chunk: number;
        readonly chunkCount: number;
        readonly jsonChunk: string;
      }
  > = [];
  let size = 0;
  let next: number | undefined;
  for (let index = Math.floor(position / 1000); index >= 1; index--) {
    const message = messages[index - 1];
    if (message === undefined) break;
    const length = JSON.stringify(message).length;
    if (chunk === 0 && length <= RESPONSE_MAX_CHARS) {
      if (read.length > 0 && size + length > RESPONSE_MAX_CHARS) {
        next = index * 1000;
        break;
      }
      read.unshift(message);
      size += length;
      continue;
    }
    if (read.length > 0) {
      next = index * 1000;
      break;
    }
    const chunks = chunksOf(message);
    read.push({
      index,
      chunk,
      chunkCount: chunks.length,
      jsonChunk: chunks[chunk] ?? "",
    });
    next =
      chunk + 1 < chunks.length
        ? index * 1000 + chunk + 1
        : index > 1
          ? (index - 1) * 1000
          : undefined;
    chunk = 0;
    break;
  }
  const first = read[0]?.index ?? messageCount + 1;
  return jsonOutput({
    threadId: thread.threadId,
    title: thread.title,
    messageCount,
    messages: read,
    ...(current && cursor === undefined && first > 1
      ? {
          note: `Messages 1–${first - 1} are outside this page; ask again with context "full" if the answer is not here.`,
        }
      : next === undefined || current
        ? {}
        : { nextCursor: cursorOf(next) }),
  });
};

/** What the reader is asked: the target thread and the question. */
export const readerUserMessage = (
  thread: LoadedThread,
  messageCount: number,
  question: string,
) => `Target thread: ${thread.title} (${thread.threadId}), ${messageCount} messages.

Question: ${question}`;

/**
 * The reader's first message when it shares the calling agent's context:
 * Flue keeps that agent's instructions and tools there, so the reader's own
 * instructions lead.
 */
export const sharedReaderPrompt = (
  thread: LoadedThread,
  messageCount: number,
  question: string,
) => `${THREAD_READER_SYSTEM_PROMPT}

${readerUserMessage(thread, messageCount, question)} Use only search_messages and read_messages.`;

/** The newest messages within budget, for context "current". */
export const currentUserMessage = (thread: LoadedThread, question: string) => {
  const { messages } = normalizeHistory(thread.page);
  const shown: string[] = [];
  let size = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const json = JSON.stringify(messages[index]);
    if (shown.length > 0 && size + json.length > CURRENT_MAX_CHARS) break;
    shown.unshift(json);
    size += json.length;
  }
  const omitted = messages.length - shown.length;
  return `Target thread: ${thread.title} (${thread.threadId}), ${messages.length} messages${
    omitted > 0
      ? `; messages 1–${omitted} are outside the current context window`
      : ""
  }.

${shown.join("\n")}

Question: ${question}`;
};

/** Context "current" sharing the calling agent's context. */
export const sharedCurrentPrompt = (thread: LoadedThread, question: string) =>
  `${CURRENT_CONTEXT_SYSTEM_PROMPT}

${currentUserMessage(thread, question)}`;
