import {
  type MessageAuthor,
  type MessageMention,
  parseMessageAuthor,
  type ThreadSettlementProvenance,
  threadSettlementProvenance,
} from "@dx/api";
import type {
  FlueConversationFinalOutput,
  FlueConversationMessage,
  FlueConversationPart,
  FlueConversationSettlement,
} from "@flue/react";
import { terminalToolActivityRowIds } from "./transcript-activity-projection.js";

export type TranscriptTurnId = `turn:${string}`;
export type TranscriptRowId = `row:${string}`;

type SourcePart = {
  readonly messageId: string;
  readonly partIndex: number;
};

export type TranscriptRow =
  | ({
      readonly kind: "user-prompt";
      /** What the person wrote, without dx's author tag. */
      readonly text: string;
      /** Who sent it, from the author tag dx prefixes to every prompt. */
      readonly author?: MessageAuthor;
      /** False for a local echo Flue has not admitted yet. */
      readonly admitted: boolean;
      /** Members it tagged, by the handle written. */
      readonly mentions?: ReadonlyArray<MessageMention>;
      /** When Flue recorded it. */
      readonly sentAt?: string;
      /** A chat message between members; it started no agent turn. */
      readonly chat?: true;
      /** Follows a message from the same author; its label is not repeated. */
      readonly continued?: true;
    } & TranscriptRowBase &
      SourcePart)
  | ({
      readonly kind: "assistant-prose" | "final-answer";
      readonly text: string;
      readonly streaming: boolean;
    } & TranscriptRowBase &
      SourcePart)
  | ({
      readonly kind: "active-work" | "settled-work";
      readonly part: Exclude<FlueConversationPart, { type: "text" | "file" }>;
      readonly toolCallId?: string;
    } & TranscriptRowBase &
      SourcePart)
  | ({
      readonly kind: "attachment";
      readonly attachment: Extract<FlueConversationPart, { type: "file" }>;
    } & TranscriptRowBase &
      SourcePart);

interface TranscriptRowBase {
  readonly id: TranscriptRowId;
  readonly turnId: TranscriptTurnId;
}

export interface TranscriptTurn {
  readonly id: TranscriptTurnId;
  readonly status:
    | "active"
    | "completed"
    | "failed"
    | "aborted"
    | "interrupted";
  readonly rowIds: ReadonlyArray<TranscriptRowId>;
  readonly intermediateRowIds: ReadonlyArray<TranscriptRowId>;
  readonly finalAnswerRowId?: TranscriptRowId;
  readonly durationMs?: number;
  readonly settlement?: {
    readonly outcome: FlueConversationSettlement["outcome"];
    readonly provenance: ThreadSettlementProvenance;
  };
  readonly workDisclosure?: {
    readonly kind: "elapsed" | "show";
    readonly collapsedRowIds: ReadonlyArray<TranscriptRowId>;
    readonly retainedRowIds: ReadonlyArray<TranscriptRowId>;
  };
}

export interface TranscriptOutlineAnchor {
  readonly id: `outline:${string}`;
  readonly rowId: TranscriptRowId;
  readonly turnId: TranscriptTurnId;
  readonly label: string;
  readonly timestamp?: string;
}

export interface TranscriptSubagentProjection {
  readonly taskId: string;
  readonly status: "active" | "completed" | "failed" | "interrupted";
  readonly summary: string;
  readonly parentTaskId?: string;
}

export interface TranscriptCapabilities {
  readonly paging: { readonly available: false };
  readonly subagents:
    | { readonly available: false }
    | {
        readonly available: true;
        readonly source: "authoritative";
        readonly items: ReadonlyArray<TranscriptSubagentProjection>;
      };
}

export interface TranscriptViewModel {
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly turns: ReadonlyArray<TranscriptTurn>;
  readonly outline: ReadonlyArray<TranscriptOutlineAnchor>;
  readonly capabilities: TranscriptCapabilities;
}

export interface DeriveTranscriptViewModelInput {
  readonly messages: ReadonlyArray<FlueConversationMessage>;
  readonly settlements: ReadonlyArray<FlueConversationSettlement>;
  readonly finalOutputs?: ReadonlyArray<FlueConversationFinalOutput>;
  readonly subagents?: ReadonlyArray<TranscriptSubagentProjection>;
  /**
   * Whether a message the viewer is still sending will be chat, from what
   * they wrote. Chat starts no run, so its local echo is not shown as one.
   */
  readonly chatEcho?: (text: string) => boolean;
}

type TranscriptToolRow = Extract<
  TranscriptRow,
  { readonly kind: "active-work" | "settled-work" }
> & {
  readonly part: Extract<
    FlueConversationPart,
    { readonly type: "dynamic-tool" }
  >;
};

const rowId = (
  messageId: string,
  identity: string,
  occurrence: number,
): TranscriptRowId => `row:${messageId}:${identity}:${occurrence}`;

const turnIdFor = (
  message: FlueConversationMessage,
  currentTurnId: TranscriptTurnId | undefined,
): TranscriptTurnId =>
  `turn:${message.turnId ?? (message.role === "user" ? message.id : (currentTurnId?.slice(5) ?? message.submissionId ?? message.id))}`;

const isActivePart = (part: FlueConversationPart) =>
  (part.type === "text" && part.state === "streaming") ||
  (part.type === "reasoning" && part.state === "streaming") ||
  (part.type === "dynamic-tool" && part.state === "input-available");

const isToolRow = (row: TranscriptRow): row is TranscriptToolRow =>
  (row.kind === "active-work" || row.kind === "settled-work") &&
  row.part.type === "dynamic-tool";

const outlineLabel = (text: string) => {
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  const characters = Array.from(normalized);
  return characters.length > 80
    ? `${characters.slice(0, 79).join("")}…`
    : normalized;
};

const authoritativeTimestamp = (message: FlueConversationMessage) => {
  const timestamp = message.timestamp ?? message.metadata?.timestamp;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    return undefined;
  }
  return timestamp;
};

const authoritativeResponseStart = (
  message: FlueConversationMessage | undefined,
) => {
  const timestamp = message?.metadata?.dxResponseStartedAt;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    return undefined;
  }
  return timestamp;
};

/**
 * Marks a prompt that directly follows a prompt from the same author, so
 * consecutive messages from one person share one label.
 */
const groupConsecutivePrompts = (
  rows: TranscriptRow[],
  turns: ReadonlyArray<TranscriptTurn>,
) => {
  const indexById = new Map(rows.map((row, index) => [row.id, index]));
  let previous: TranscriptRow | undefined;
  for (const turn of turns) {
    for (const rowId of turn.rowIds) {
      const index = indexById.get(rowId);
      const row = index === undefined ? undefined : rows[index];
      if (row === undefined || index === undefined) continue;
      if (
        row.kind === "user-prompt" &&
        previous?.kind === "user-prompt" &&
        row.author !== undefined &&
        previous.author?.userId === row.author.userId
      )
        rows[index] = { ...row, continued: true };
      previous = row;
    }
  }
};

export const deriveTranscriptViewModel = ({
  messages,
  settlements,
  finalOutputs = [],
  subagents,
  chatEcho,
}: DeriveTranscriptViewModelInput): TranscriptViewModel => {
  const settlementBySubmission = new Map(
    settlements.map((settlement) => [settlement.submissionId, settlement]),
  );
  const rows: TranscriptRow[] = [];
  const rowIndexById = new Map<TranscriptRowId, number>();
  const turnOrder: TranscriptTurnId[] = [];
  const turnRows = new Map<TranscriptTurnId, TranscriptRow[]>();
  const turnMessages = new Map<TranscriptTurnId, FlueConversationMessage[]>();
  const messageById = new Map<string, FlueConversationMessage>();
  const finalOutputByMessageId = new Map(
    finalOutputs.map((output) => [output.messageId, output]),
  );
  let currentTurnId: TranscriptTurnId | undefined;
  // Chat sent while a turn runs shows where it was sent: when the turn's
  // output continues after the chat, it continues in a new segment.
  const continuation = new Map<TranscriptTurnId, TranscriptTurnId>();
  const chatMessageIds = new Set<string>();
  let chatAfterTurn: string | undefined;
  const segmentOf = (turnId: TranscriptTurnId) => {
    let segment = turnId;
    for (let next = continuation.get(segment); next !== undefined; ) {
      segment = next;
      next = continuation.get(segment);
    }
    return segment;
  };

  for (const message of messages) {
    messageById.set(message.id, message);
    if (message.display !== "visible" && message.settlement === undefined) {
      continue;
    }
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.settlement === undefined
    ) {
      continue;
    }

    const chat =
      message.purpose === "chat" ||
      (chatEcho !== undefined &&
        message.role === "user" &&
        message.submissionId === undefined &&
        chatEcho(
          message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
        ));
    let turnId: TranscriptTurnId;
    if (chat) {
      chatMessageIds.add(message.id);
      turnId = `turn:chat:${message.id}`;
      if (currentTurnId !== undefined) chatAfterTurn = message.id;
    } else {
      const next = turnIdFor(message, currentTurnId);
      if (chatAfterTurn !== undefined && next === currentTurnId) {
        const segment = segmentOf(next);
        continuation.set(segment, `${segment}~${chatAfterTurn}`);
      }
      chatAfterTurn = undefined;
      currentTurnId = next;
      turnId = segmentOf(next);
    }
    if (!turnRows.has(turnId)) {
      turnOrder.push(turnId);
      turnRows.set(turnId, []);
      turnMessages.set(turnId, []);
    }
    turnMessages.get(turnId)?.push(message);
    const targetRows = turnRows.get(turnId);
    if (targetRows === undefined) continue;
    const occurrences = new Map<string, number>();

    for (const [partIndex, part] of message.parts.entries()) {
      if (message.settlement !== undefined) break;
      const identity =
        part.type === "dynamic-tool"
          ? `tool:${part.toolCallId}`
          : part.type === "file"
            ? `file:${part.id ?? part.url ?? part.filename ?? part.mediaType}`
            : part.type;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const id = rowId(message.id, identity, occurrence);
      const source = { id, turnId, messageId: message.id, partIndex };
      let row: TranscriptRow | undefined;

      if (part.type === "text") {
        if (message.role === "user") {
          const { author, mentions, text } = parseMessageAuthor(part.text);
          if (!text.trim()) continue;
          const sentAt = authoritativeTimestamp(message);
          row = {
            ...source,
            kind: "user-prompt",
            text,
            ...(author === undefined ? {} : { author }),
            ...(mentions === undefined ? {} : { mentions }),
            admitted: message.submissionId !== undefined,
            ...(sentAt === undefined ? {} : { sentAt }),
            ...(chat ? { chat: true as const } : {}),
          };
        } else {
          if (!part.text.trim()) continue;
          row = {
            ...source,
            kind: "assistant-prose",
            text: part.text,
            ...(message.role === "assistant"
              ? { streaming: part.state === "streaming" }
              : {}),
          } as TranscriptRow;
        }
      } else if (part.type === "file") {
        row = { ...source, kind: "attachment", attachment: part };
      } else {
        if (part.type === "reasoning" && !part.text.trim()) continue;
        row = {
          ...source,
          kind: isActivePart(part) ? "active-work" : "settled-work",
          part,
          ...(part.type === "dynamic-tool"
            ? { toolCallId: part.toolCallId }
            : {}),
        };
      }
      rowIndexById.set(row.id, rows.length);
      rows.push(row);
      targetRows.push(row);
    }
  }

  const turns = turnOrder.map((id): TranscriptTurn => {
    const turn = turnRows.get(id) ?? [];
    const messagesInTurn = turnMessages.get(id) ?? [];
    const submissionIds = messagesInTurn.flatMap((message) =>
      message.submissionId ? [message.submissionId] : [],
    );
    const settlement = submissionIds
      .map((submissionId) => settlementBySubmission.get(submissionId))
      .findLast((value) => value !== undefined);
    const provenance =
      settlement?.outcome === "aborted"
        ? threadSettlementProvenance(settlement.error)
        : "non-user";
    const messageSettlement = messagesInTurn
      .map((message) => message.settlement)
      .findLast((value) => value !== undefined);
    // Chat starts no run, so it never settles.
    const outcome =
      messagesInTurn.length > 0 &&
      messagesInTurn.every((message) => chatMessageIds.has(message.id))
        ? "completed"
        : (settlement?.outcome ?? messageSettlement?.outcome);
    const status =
      outcome === "failed"
        ? "failed"
        : outcome === "aborted"
          ? "aborted"
          : outcome === "completed"
            ? "completed"
            : "active";
    const answer = [...turn]
      .reverse()
      .find(
        (
          row,
        ): row is Extract<
          TranscriptRow,
          { readonly kind: "assistant-prose" | "final-answer" }
        > & { readonly kind: "assistant-prose" } =>
          row.kind === "assistant-prose",
      );
    // The answer is in the run's last segment, after any chat.
    const finalAnswerRowId =
      status === "completed" && !continuation.has(id) ? answer?.id : undefined;
    if (answer?.kind === "assistant-prose" && finalAnswerRowId) {
      const finalAnswer: TranscriptRow = { ...answer, kind: "final-answer" };
      const turnIndex = turn.findIndex((row) => row.id === finalAnswerRowId);
      const rowIndex = rowIndexById.get(finalAnswerRowId);
      turn[turnIndex] = finalAnswer;
      if (rowIndex !== undefined) rows[rowIndex] = finalAnswer;
    }
    const intermediateRowIds = turn.flatMap((row) =>
      row.id === finalAnswerRowId || row.kind === "user-prompt" ? [] : [row.id],
    );
    const toolRows = turn.filter(isToolRow);
    const finalOutput = messagesInTurn
      .map((message) => finalOutputByMessageId.get(message.id))
      .findLast((output) => output !== undefined);
    const responseStartedAt = authoritativeResponseStart(
      finalOutput === undefined
        ? undefined
        : messageById.get(finalOutput.messageId),
    );
    const elapsedMs =
      responseStartedAt !== undefined && finalOutput !== undefined
        ? Date.parse(finalOutput.timestamp) - Date.parse(responseStartedAt)
        : undefined;
    const durationMs =
      toolRows.length > 0 &&
      elapsedMs !== undefined &&
      Number.isFinite(elapsedMs) &&
      elapsedMs >= 0
        ? elapsedMs
        : undefined;
    const terminalActivityIds =
      status === "completed" || status === "active"
        ? []
        : terminalToolActivityRowIds(turn);
    const retainedIds = new Set(terminalActivityIds);
    const workDisclosure =
      toolRows.length === 0 || status === "active"
        ? undefined
        : {
            kind:
              status === "completed" ? ("elapsed" as const) : ("show" as const),
            collapsedRowIds: intermediateRowIds.filter(
              (rowId) => !retainedIds.has(rowId),
            ),
            retainedRowIds: terminalActivityIds,
          };
    return {
      id,
      status,
      rowIds: turn.map((row) => row.id),
      intermediateRowIds,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(finalAnswerRowId ? { finalAnswerRowId } : {}),
      ...(settlement
        ? {
            settlement: {
              outcome: settlement.outcome,
              provenance,
            },
          }
        : {}),
      ...(workDisclosure ? { workDisclosure } : {}),
    };
  });

  const outline = rows.flatMap((row): TranscriptOutlineAnchor[] =>
    row.kind === "user-prompt" && row.chat !== true
      ? (() => {
          const timestamp = authoritativeTimestamp(
            messageById.get(row.messageId) as FlueConversationMessage,
          );
          return [
            {
              id: `outline:${row.id.slice(4)}`,
              rowId: row.id,
              turnId: row.turnId,
              label: outlineLabel(row.text),
              ...(timestamp ? { timestamp } : {}),
            },
          ];
        })()
      : [],
  );

  const capabilities: TranscriptCapabilities = {
    paging: { available: false },
    subagents:
      subagents === undefined
        ? { available: false }
        : { available: true, source: "authoritative", items: subagents },
  };

  groupConsecutivePrompts(rows, turns);
  return { rows, turns, outline, capabilities };
};

/** Groups rows by turn once per model instead of searching rows per render. */
export const transcriptRowsByTurn = (
  model: TranscriptViewModel,
): ReadonlyMap<TranscriptTurnId, ReadonlyArray<TranscriptRow>> => {
  const byId = new Map(model.rows.map((row) => [row.id, row]));
  return new Map(
    model.turns.map((turn) => [
      turn.id,
      turn.rowIds.flatMap((id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [row];
      }),
    ]),
  );
};

const sameIds = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((id, index) => id === b[index]));

/**
 * Whether two derivations of a row render identically. Every derivation
 * creates new row objects, but Flue keeps unchanged parts and strings by
 * identity, so this comparison is cheap and lets unchanged rows skip render.
 */
export const sameTranscriptRow = (a: TranscriptRow, b: TranscriptRow) => {
  if (a === b) return true;
  if (a.id !== b.id || a.kind !== b.kind || a.turnId !== b.turnId) return false;
  // A sent prompt learns its author once Flue admits it.
  if (
    a.kind === "user-prompt" &&
    b.kind === "user-prompt" &&
    (a.admitted !== b.admitted ||
      a.author?.userId !== b.author?.userId ||
      a.sentAt !== b.sentAt ||
      a.continued !== b.continued ||
      a.mentions?.length !== b.mentions?.length)
  )
    return false;
  if ("text" in a && "text" in b) {
    if (a.text !== b.text) return false;
    if ("streaming" in a || "streaming" in b)
      return (
        "streaming" in a && "streaming" in b && a.streaming === b.streaming
      );
    return true;
  }
  if ("part" in a && "part" in b) return a.part === b.part;
  if ("attachment" in a && "attachment" in b)
    return a.attachment === b.attachment;
  return false;
};

export const sameTranscriptRows = (
  a: ReadonlyArray<TranscriptRow>,
  b: ReadonlyArray<TranscriptRow>,
) =>
  a === b ||
  (a.length === b.length &&
    a.every((row, index) => sameTranscriptRow(row, b[index] as TranscriptRow)));

/** Whether two derivations of a turn render identically (see rows above). */
export const sameTranscriptTurn = (a: TranscriptTurn, b: TranscriptTurn) =>
  a === b ||
  (a.id === b.id &&
    a.status === b.status &&
    a.durationMs === b.durationMs &&
    a.finalAnswerRowId === b.finalAnswerRowId &&
    a.settlement?.outcome === b.settlement?.outcome &&
    a.settlement?.provenance === b.settlement?.provenance &&
    sameIds(a.rowIds, b.rowIds) &&
    sameIds(a.intermediateRowIds, b.intermediateRowIds) &&
    a.workDisclosure?.kind === b.workDisclosure?.kind &&
    sameIds(
      a.workDisclosure?.collapsedRowIds,
      b.workDisclosure?.collapsedRowIds,
    ) &&
    sameIds(
      a.workDisclosure?.retainedRowIds,
      b.workDisclosure?.retainedRowIds,
    ));
