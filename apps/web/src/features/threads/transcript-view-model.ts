import {
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
      readonly text: string;
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
      SourcePart)
  | ({
      readonly kind: "failure";
      readonly outcome: "failed" | "aborted";
      readonly detail?: string;
      readonly messageId?: string;
      readonly partIndex?: number;
    } & TranscriptRowBase);

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

const settlementDetail = (error: unknown): string | undefined => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
};

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
  const timestamp = message.metadata?.timestamp;
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

export const deriveTranscriptViewModel = ({
  messages,
  settlements,
  finalOutputs = [],
  subagents,
}: DeriveTranscriptViewModelInput): TranscriptViewModel => {
  const settlementBySubmission = new Map(
    settlements.map((settlement) => [settlement.submissionId, settlement]),
  );
  const rows: TranscriptRow[] = [];
  const turnOrder: TranscriptTurnId[] = [];
  const turnRows = new Map<TranscriptTurnId, TranscriptRow[]>();
  const turnMessages = new Map<TranscriptTurnId, FlueConversationMessage[]>();
  const messageById = new Map<string, FlueConversationMessage>();
  const finalOutputByMessageId = new Map(
    finalOutputs.map((output) => [output.messageId, output]),
  );
  let currentTurnId: TranscriptTurnId | undefined;

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

    const turnId = turnIdFor(message, currentTurnId);
    currentTurnId = turnId;
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
        if (!part.text.trim()) continue;
        row = {
          ...source,
          kind: message.role === "user" ? "user-prompt" : "assistant-prose",
          text: part.text,
          ...(message.role === "assistant"
            ? { streaming: part.state === "streaming" }
            : {}),
        } as TranscriptRow;
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
      rows.push(row);
      targetRows.push(row);
    }

    if (message.settlement !== undefined) {
      const outcome =
        message.settlement.outcome === "failed" ? "failed" : "aborted";
      const settlement = message.submissionId
        ? settlementBySubmission.get(message.submissionId)
        : undefined;
      if (
        settlement?.outcome === "aborted" &&
        threadSettlementProvenance(settlement.error) === "user-stop"
      ) {
        continue;
      }
      const failure: TranscriptRow = {
        id: rowId(message.id, `settlement:${outcome}`, 0),
        turnId,
        kind: "failure",
        outcome,
        detail:
          settlementDetail(settlement?.error) ??
          message.parts.find((part) => part.type === "text")?.text,
        messageId: message.id,
      };
      rows.push(failure);
      targetRows.push(failure);
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
    const failure = turn.find((row) => row.kind === "failure");
    const status = failure
      ? failure.outcome
      : settlement?.outcome === "failed"
        ? "failed"
        : settlement?.outcome === "aborted"
          ? "aborted"
          : settlement?.outcome === "completed"
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
    const finalAnswerRowId = status === "completed" ? answer?.id : undefined;
    if (answer?.kind === "assistant-prose" && finalAnswerRowId) {
      const finalAnswer: TranscriptRow = { ...answer, kind: "final-answer" };
      const turnIndex = turn.findIndex((row) => row.id === finalAnswerRowId);
      const rowIndex = rows.findIndex((row) => row.id === finalAnswerRowId);
      turn[turnIndex] = finalAnswer;
      rows[rowIndex] = finalAnswer;
    }
    const intermediateRowIds = turn.flatMap((row) =>
      row.id === finalAnswerRowId ||
      row.kind === "user-prompt" ||
      row.kind === "failure"
        ? []
        : [row.id],
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
    row.kind === "user-prompt"
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

  return { rows, turns, outline, capabilities };
};
