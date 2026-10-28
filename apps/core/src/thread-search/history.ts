import { stripMessageAuthorTags } from "@dx/api";
import type { UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { ownerRequest } from "../threads/owner-request.js";

/** One message of Flue's history read, as the web client receives it. */
export interface HistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly purpose?: string;
  readonly submissionId?: string;
  readonly timestamp?: string;
  readonly parts?: ReadonlyArray<HistoryPart>;
}

export interface HistoryPart {
  readonly type?: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly state?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly errorText?: string;
}

export type SettlementOutcome = "completed" | "failed" | "aborted";

export interface HistoryPage {
  readonly messages: ReadonlyArray<HistoryMessage>;
  /**
   * How each settled submission ended; a reply whose submission is absent
   * may still be streaming.
   */
  readonly settled: ReadonlyMap<string, SettlementOutcome>;
  /**
   * For a message sent while a turn ran, the submission whose response
   * answered it; Flue settles both together.
   */
  readonly answeredBy: ReadonlyMap<string, string>;
  /** Whether older prompts exist before this page. */
  readonly hasOlder: boolean;
}

export type HistoryRead =
  | { readonly kind: "page"; readonly page: HistoryPage }
  /** No conversation yet. */
  | { readonly kind: "empty" }
  /** Flue is still indexing; try again later. */
  | { readonly kind: "busy" }
  | { readonly kind: "unavailable"; readonly status: number };

/** The searchable text of one message. */
export interface IndexableMessage {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Text past this many characters of one message is not searchable. */
export const INDEXED_MESSAGE_MAX_CHARS = 32_000;

const textOf = (parts: ReadonlyArray<HistoryPart>) =>
  parts
    .flatMap(({ type, text }) => (type === "text" && text ? [text] : []))
    .join("\n")
    .trim();

/** An assistant response's final reply: its text after its last tool call. */
export const finalReplyText = (parts: ReadonlyArray<HistoryPart>) => {
  const lastTool = parts.findLastIndex(({ type }) => type === "dynamic-tool");
  return textOf(lastTool < 0 ? parts : parts.slice(lastTool + 1));
};

/**
 * What the index holds: people's messages and the agent's
 * final replies. Tool calls, tool results, reasoning, text written between
 * tool calls, and replies still streaming are left out.
 */
export const indexableMessages = (page: HistoryPage): IndexableMessage[] =>
  page.messages.flatMap((message): IndexableMessage[] => {
    const parts = message.parts ?? [];
    const text =
      message.role === "user"
        ? stripMessageAuthorTags(textOf(parts)).trim()
        : message.role === "assistant" &&
            message.purpose === "assistant" &&
            message.submissionId !== undefined &&
            page.settled.has(message.submissionId)
          ? finalReplyText(parts)
          : "";
    if (text === "") return [];
    return [
      {
        messageId: message.id,
        role: message.role === "user" ? "user" : "assistant",
        text: text.slice(0, INDEXED_MESSAGE_MAX_CHARS),
      },
    ];
  });

/**
 * Reads a Thread's history as its owner through the route the web client
 * uses. `promptLimit` reads only the latest prompts and their responses;
 * omitted, the whole active history. `settlementIds` adds those submissions'
 * settlements to a limited page.
 */
export const readHistory = async (
  bindings: Bindings,
  ownerUserId: UserId,
  threadId: string,
  promptLimit?: number,
  settlementIds?: ReadonlyArray<string>,
): Promise<HistoryRead> => {
  const { response, payload } = await ownerRequest(
    { bindings, ownerUserId },
    "GET",
    `/v1/agents/dx/${encodeURIComponent(threadId)}?view=history${
      promptLimit === undefined ? "" : `&promptLimit=${promptLimit}`
    }${
      settlementIds === undefined
        ? ""
        : `&settlementIds=${encodeURIComponent(JSON.stringify(settlementIds))}`
    }`,
  );
  if (response.status === 404) return { kind: "empty" };
  if (response.status === 503) return { kind: "busy" };
  if (!response.ok || payload === undefined)
    return { kind: "unavailable", status: response.status };
  const settlements = (payload.settlements ?? []) as ReadonlyArray<{
    readonly submissionId?: string;
    readonly outcome?: SettlementOutcome;
    /** A steered message settles with the response that answered it. */
    readonly answeredBySubmissionId?: string;
  }>;
  const settled = new Map<string, SettlementOutcome>();
  const answeredBy = new Map<string, string>();
  for (const { submissionId, outcome, answeredBySubmissionId } of settlements) {
    for (const id of [submissionId, answeredBySubmissionId])
      if (id !== undefined && !settled.has(id))
        settled.set(id, outcome ?? "completed");
    if (submissionId !== undefined && answeredBySubmissionId !== undefined)
      answeredBy.set(submissionId, answeredBySubmissionId);
  }
  return {
    kind: "page",
    page: {
      messages: (payload.messages ?? []) as ReadonlyArray<HistoryMessage>,
      settled,
      answeredBy,
      hasOlder: typeof payload.olderCursor === "string",
    },
  };
};
