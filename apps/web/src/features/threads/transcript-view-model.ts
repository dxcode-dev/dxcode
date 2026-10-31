import {
  type MessageAttachment,
  type MessageAuthor,
  type MessageAutomation,
  type MessageMention,
  parseMessageAttachments,
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
import { presentableToolPart } from "./claude-code-tools.js";
import { isSkillActivationTool } from "./skill-activation.js";
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
      /** The files the message references, from its attachment block. */
      readonly attachments?: ReadonlyArray<MessageAttachment>;
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
      /** Another of the owner's Threads sent it with a Thread tool. */
      readonly sourceThreadId?: string;
      /** The Thread's schedule or a GitHub subscription delivered it. */
      readonly automation?: MessageAutomation;
      /** dx's name for a message that tags someone; notifications link to it. */
      readonly dxMessageId?: string;
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
    /** `stopped` is a turn the person stopped. */
    readonly kind: "elapsed" | "stopped" | "show";
    readonly collapsedRowIds: ReadonlyArray<TranscriptRowId>;
    readonly retainedRowIds: ReadonlyArray<TranscriptRowId>;
    /** Skill activations, shown above the disclosure in every outcome. */
    readonly pinnedRowIds: ReadonlyArray<TranscriptRowId>;
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

const sameItems = <T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) =>
  a === b ||
  (a.length === b.length && a.every((item, index) => item === b[index]));

/**
 * The rows one message renders. Flue keeps an unchanged message by identity,
 * so its rows are built once and reused while it stays in the same turn.
 */
const messageRowsCache = new WeakMap<
  FlueConversationMessage,
  {
    readonly turnId: TranscriptTurnId;
    readonly chat: boolean;
    readonly rows: ReadonlyArray<TranscriptRow>;
  }
>();

const messageRows = (
  message: FlueConversationMessage,
  turnId: TranscriptTurnId,
  chat: boolean,
): ReadonlyArray<TranscriptRow> => {
  const cached = messageRowsCache.get(message);
  if (cached !== undefined && cached.turnId === turnId && cached.chat === chat)
    return cached.rows;
  const rows: TranscriptRow[] = [];
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

    if (part.type === "text") {
      if (message.role === "user") {
        const parsedAuthor = parseMessageAuthor(part.text);
        const { author, mentions, sourceThreadId, messageId, automation } =
          parsedAuthor;
        const { attachments, text } = parseMessageAttachments(
          parsedAuthor.text,
        );
        if (!text.trim() && attachments.length === 0) continue;
        const sentAt = authoritativeTimestamp(message);
        rows.push({
          ...source,
          kind: "user-prompt",
          text,
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(author === undefined ? {} : { author }),
          ...(mentions === undefined ? {} : { mentions }),
          ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
          ...(automation === undefined ? {} : { automation }),
          ...(messageId === undefined ? {} : { dxMessageId: messageId }),
          admitted: message.submissionId !== undefined,
          ...(sentAt === undefined ? {} : { sentAt }),
          ...(chat ? { chat: true as const } : {}),
        });
      } else {
        if (!part.text.trim()) continue;
        rows.push({
          ...source,
          kind: "assistant-prose",
          text: part.text,
          ...(message.role === "assistant"
            ? { streaming: part.state === "streaming" }
            : {}),
        } as TranscriptRow);
      }
    } else if (part.type === "file") {
      rows.push({ ...source, kind: "attachment", attachment: part });
    } else {
      if (part.type === "reasoning" && !part.text.trim()) continue;
      rows.push({
        ...source,
        kind: isActivePart(part) ? "active-work" : "settled-work",
        part: part.type === "dynamic-tool" ? presentableToolPart(part) : part,
        ...(part.type === "dynamic-tool"
          ? { toolCallId: part.toolCallId }
          : {}),
      });
    }
  }
  messageRowsCache.set(message, { turnId, chat, rows });
  return rows;
};

/** One variant object per row, so a re-derivation reuses it. */
const rowVariant = <Variant>(create: (row: TranscriptRow) => Variant) => {
  const variants = new WeakMap<TranscriptRow, Variant>();
  return (row: TranscriptRow) => {
    const existing = variants.get(row);
    if (existing !== undefined) return existing;
    const variant = create(row);
    variants.set(row, variant);
    return variant;
  };
};

/** A completed turn's last reply is its answer. */
const asFinalAnswer = rowVariant(
  (row): TranscriptRow => ({ ...row, kind: "final-answer" }) as TranscriptRow,
);

/** A prompt that follows one from the same author shares its label. */
const asContinued = rowVariant(
  (row): TranscriptRow => ({ ...row, continued: true }) as TranscriptRow,
);

const continuesPrompt = (
  previous: TranscriptRow | undefined,
  row: TranscriptRow,
) =>
  row.kind === "user-prompt" &&
  previous?.kind === "user-prompt" &&
  row.author !== undefined &&
  previous.author?.userId === row.author.userId &&
  // A message another Thread sent carries the owner's id; it neither
  // continues nor is continued by the owner's own messages.
  previous.sourceThreadId === row.sourceThreadId &&
  previous.automation === row.automation;

/** What a turn derives from; the same inputs give the same turn. */
interface TurnInputs {
  readonly sourceRows: ReadonlyArray<TranscriptRow>;
  readonly messages: ReadonlyArray<FlueConversationMessage>;
  readonly settlement: FlueConversationSettlement | undefined;
  readonly finalOutput: FlueConversationFinalOutput | undefined;
  readonly finalOutputMessage: FlueConversationMessage | undefined;
  /** Every message in it is chat, which starts no run and never settles. */
  readonly chatOnly: boolean;
  /** The run continues in a later segment, after chat. */
  readonly continues: boolean;
}

interface DerivedTurn extends TurnInputs {
  readonly turn: TranscriptTurn;
  /** Its rows, with the answer as a final answer. */
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly finalAnswer?: TranscriptRow;
}

const sameTurnInputs = (a: TurnInputs, b: TurnInputs) =>
  a.settlement === b.settlement &&
  a.finalOutput === b.finalOutput &&
  a.finalOutputMessage === b.finalOutputMessage &&
  a.chatOnly === b.chatOnly &&
  a.continues === b.continues &&
  sameItems(a.sourceRows, b.sourceRows) &&
  sameItems(a.messages, b.messages);

const deriveTurn = (id: TranscriptTurnId, inputs: TurnInputs): DerivedTurn => {
  const { sourceRows, messages, settlement, finalOutput } = inputs;
  const provenance =
    settlement?.outcome === "aborted"
      ? threadSettlementProvenance(settlement.error)
      : "non-user";
  const messageSettlement = messages
    .map((message) => message.settlement)
    .findLast((value) => value !== undefined);
  const outcome = inputs.chatOnly
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
  const answer = sourceRows.findLast((row) => row.kind === "assistant-prose");
  // The answer is in the run's last segment, after any chat.
  const finalAnswerRowId =
    status === "completed" && !inputs.continues ? answer?.id : undefined;
  const finalAnswer =
    answer !== undefined && finalAnswerRowId !== undefined
      ? asFinalAnswer(answer)
      : undefined;
  const rows =
    finalAnswer === undefined
      ? sourceRows
      : sourceRows.map((row) => (row === answer ? finalAnswer : row));
  const intermediateRowIds = rows.flatMap((row) =>
    row.id === finalAnswerRowId || row.kind === "user-prompt" ? [] : [row.id],
  );
  const toolRows = rows.filter(isToolRow);
  const responseStartedAt = authoritativeResponseStart(
    inputs.finalOutputMessage,
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
      : terminalToolActivityRowIds(rows);
  const pinnedRowIds = toolRows.flatMap((row) =>
    row.part.type === "dynamic-tool" && isSkillActivationTool(row.part.toolName)
      ? [row.id]
      : [],
  );
  const pinnedIds = new Set(pinnedRowIds);
  const retainedRowIds = terminalActivityIds.filter(
    (rowId) => !pinnedIds.has(rowId),
  );
  const retainedIds = new Set(retainedRowIds);
  const workDisclosure =
    toolRows.length === 0 || status === "active"
      ? undefined
      : {
          kind:
            status === "completed"
              ? ("elapsed" as const)
              : status === "aborted" && provenance === "user-stop"
                ? ("stopped" as const)
                : ("show" as const),
          collapsedRowIds: intermediateRowIds.filter(
            (rowId) => !retainedIds.has(rowId) && !pinnedIds.has(rowId),
          ),
          retainedRowIds,
          pinnedRowIds,
        };
  return {
    ...inputs,
    rows,
    ...(finalAnswer === undefined ? {} : { finalAnswer }),
    turn: {
      id,
      status,
      rowIds: rows.map((row) => row.id),
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
    },
  };
};

const outlineAnchor = rowVariant((row): TranscriptOutlineAnchor => {
  const timestamp = row.kind === "user-prompt" ? row.sentAt : undefined;
  return {
    id: `outline:${row.id.slice(4)}`,
    rowId: row.id,
    turnId: row.turnId,
    label: outlineLabel(row.kind === "user-prompt" ? row.text : ""),
    ...(timestamp ? { timestamp } : {}),
  };
});

/** Lookups by id, built once per settlements or final outputs array. */
const settlementIndexes = new WeakMap<
  ReadonlyArray<FlueConversationSettlement>,
  ReadonlyMap<string, FlueConversationSettlement>
>();
const finalOutputIndexes = new WeakMap<
  ReadonlyArray<FlueConversationFinalOutput>,
  ReadonlyMap<string, FlueConversationFinalOutput>
>();
const indexed = <Item, Key extends keyof Item>(
  cache: WeakMap<ReadonlyArray<Item>, ReadonlyMap<string, Item>>,
  items: ReadonlyArray<Item>,
  key: Key,
) => {
  const existing = cache.get(items);
  if (existing !== undefined) return existing;
  const index = new Map(items.map((item) => [String(item[key]), item]));
  cache.set(items, index);
  return index;
};

/** Where the walk over messages stands before one of them. */
interface WalkState {
  readonly currentTurnId: TranscriptTurnId | undefined;
  readonly chatAfterTurn: string | undefined;
  readonly continuation: ReadonlyMap<TranscriptTurnId, TranscriptTurnId>;
}

/**
 * The derived transcript before the latest turn began. Messages before
 * `index` that are unchanged derive exactly this prefix, so the next
 * derivation walks only from `index`: a streamed frame walks the live turn.
 */
interface Checkpoint {
  readonly messages: ReadonlyArray<FlueConversationMessage>;
  readonly index: number;
  readonly settlements: ReadonlyArray<FlueConversationSettlement>;
  readonly finalOutputs: ReadonlyArray<FlueConversationFinalOutput>;
  readonly chatEcho: DeriveTranscriptViewModelInput["chatEcho"];
  readonly walk: WalkState;
  readonly turnIds: ReadonlySet<TranscriptTurnId>;
  readonly turns: ReadonlyArray<TranscriptTurn>;
  /** Rows as shown, in message order. */
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly outline: ReadonlyArray<TranscriptOutlineAnchor>;
  readonly derived: ReadonlyMap<TranscriptTurnId, DerivedTurn>;
  readonly rowsByTurn: ReadonlyMap<
    TranscriptTurnId,
    ReadonlyArray<TranscriptRow>
  >;
  /** The last row in turn order, which the next prompt may continue. */
  readonly lastRow: TranscriptRow | undefined;
}

const startOfHistory = (
  messages: ReadonlyArray<FlueConversationMessage>,
  settlements: ReadonlyArray<FlueConversationSettlement>,
  finalOutputs: ReadonlyArray<FlueConversationFinalOutput>,
  chatEcho: DeriveTranscriptViewModelInput["chatEcho"],
): Checkpoint => ({
  messages,
  index: 0,
  settlements,
  finalOutputs,
  chatEcho,
  walk: {
    currentTurnId: undefined,
    chatAfterTurn: undefined,
    continuation: new Map(),
  },
  turnIds: new Set(),
  turns: [],
  rows: [],
  outline: [],
  derived: new Map(),
  rowsByTurn: new Map(),
  lastRow: undefined,
});

/** What a derivation reuses from the one before it. */
const derivations = new WeakMap<
  TranscriptViewModel,
  {
    readonly checkpoint: Checkpoint;
    /** Turns after the checkpoint; the checkpoint holds the rest. */
    readonly derived: ReadonlyMap<TranscriptTurnId, DerivedTurn>;
    readonly rowsByTurn: ReadonlyMap<
      TranscriptTurnId,
      ReadonlyArray<TranscriptRow>
    >;
  }
>();

/** The previous derivation's turns and shown rows, by turn. */
interface PriorDerivation {
  readonly turn: (id: TranscriptTurnId) => DerivedTurn | undefined;
  readonly rows: (
    id: TranscriptTurnId,
  ) => ReadonlyArray<TranscriptRow> | undefined;
}

const samePrefix = (
  previous: ReadonlyArray<FlueConversationMessage>,
  next: ReadonlyArray<FlueConversationMessage>,
  length: number,
) => {
  if (previous === next) return true;
  if (next.length < length) return false;
  for (let index = 0; index < length; index++)
    if (previous[index] !== next[index]) return false;
  return true;
};

/**
 * Walks messages from `base.index` and derives the turns they form. Returns
 * undefined when a message changes a turn before the checkpoint, which then
 * no longer describes the prefix.
 */
const deriveFrom = (
  base: Checkpoint,
  input: DeriveTranscriptViewModelInput,
  prior: PriorDerivation | undefined,
) => {
  const { messages, settlements, finalOutputs = [], chatEcho } = input;
  const settlementBySubmission = indexed(
    settlementIndexes,
    settlements,
    "submissionId",
  );
  const finalOutputByMessageId = indexed(
    finalOutputIndexes,
    finalOutputs,
    "messageId",
  );
  const rows: TranscriptRow[] = [];
  const rowIndexById = new Map<TranscriptRowId, number>();
  const turnOrder: TranscriptTurnId[] = [];
  const turnRows = new Map<TranscriptTurnId, TranscriptRow[]>();
  const turnMessages = new Map<TranscriptTurnId, FlueConversationMessage[]>();
  let currentTurnId = base.walk.currentTurnId;
  let chatAfterTurn = base.walk.chatAfterTurn;
  // Chat sent while a turn runs shows where it was sent: when the turn's
  // output continues after the chat, it continues in a new segment.
  const continuation = new Map(base.walk.continuation);
  const chatMessageIds = new Set<string>();
  const segmentOf = (turnId: TranscriptTurnId) => {
    let segment = turnId;
    for (let next = continuation.get(segment); next !== undefined; ) {
      segment = next;
      next = continuation.get(segment);
    }
    return segment;
  };
  const turnIndex = new Map<TranscriptTurnId, number>();
  // The latest turn's start, where the next derivation can resume, unless a
  // later message changes an earlier turn.
  let latest:
    | {
        readonly index: number;
        readonly walk: WalkState;
        readonly turns: number;
        readonly rows: number;
      }
    | undefined;

  for (let index = base.index; index < messages.length; index++) {
    const message = messages[index] as FlueConversationMessage;
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
    const before = { currentTurnId, chatAfterTurn };
    let continued: TranscriptTurnId | undefined;

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
        continued = segmentOf(next);
        if (base.turnIds.has(continued)) return undefined;
        continuation.set(continued, `${continued}~${chatAfterTurn}`);
      }
      chatAfterTurn = undefined;
      currentTurnId = next;
      turnId = segmentOf(next);
    }
    if (base.turnIds.has(turnId)) return undefined;
    let targetRows = turnRows.get(turnId);
    if (targetRows === undefined) {
      // A turn that continues an earlier one changes it; never resume there.
      latest =
        continued === undefined
          ? {
              index,
              walk: { ...before, continuation: new Map(continuation) },
              turns: turnOrder.length,
              rows: rows.length,
            }
          : undefined;
      turnIndex.set(turnId, turnOrder.length);
      targetRows = [];
      turnOrder.push(turnId);
      turnRows.set(turnId, targetRows);
      turnMessages.set(turnId, []);
    } else if (
      latest !== undefined &&
      (turnIndex.get(turnId) ?? 0) < latest.turns
    ) {
      // A later message joined an earlier turn.
      latest = undefined;
    }
    if (
      continued !== undefined &&
      latest !== undefined &&
      (turnIndex.get(continued) ?? 0) < latest.turns
    )
      latest = undefined;
    turnMessages.get(turnId)?.push(message);
    for (const row of messageRows(message, turnId, chat)) {
      rowIndexById.set(row.id, rows.length);
      rows.push(row);
      targetRows.push(row);
    }
  }

  const derived = new Map<TranscriptTurnId, DerivedTurn>();
  for (const id of turnOrder) {
    const messagesInTurn = turnMessages.get(id) ?? [];
    let settlement: FlueConversationSettlement | undefined;
    let finalOutput: FlueConversationFinalOutput | undefined;
    let finalOutputMessage: FlueConversationMessage | undefined;
    for (const message of messagesInTurn) {
      const submitted =
        message.submissionId === undefined || message.submissionId === ""
          ? undefined
          : settlementBySubmission.get(message.submissionId);
      if (submitted !== undefined) settlement = submitted;
      const output = finalOutputByMessageId.get(message.id);
      if (output !== undefined) {
        finalOutput = output;
        finalOutputMessage = message;
      }
    }
    const inputs: TurnInputs = {
      sourceRows: turnRows.get(id) ?? [],
      messages: messagesInTurn,
      settlement,
      finalOutput,
      finalOutputMessage,
      chatOnly:
        messagesInTurn.length > 0 &&
        messagesInTurn.every((message) => chatMessageIds.has(message.id)),
      continues: continuation.has(id),
    };
    const cached = prior?.turn(id);
    const turn =
      cached !== undefined && sameTurnInputs(cached, inputs)
        ? cached
        : deriveTurn(id, inputs);
    derived.set(id, turn);
    const { finalAnswer } = turn;
    const finalIndex =
      finalAnswer === undefined ? undefined : rowIndexById.get(finalAnswer.id);
    if (finalAnswer !== undefined && finalIndex !== undefined)
      rows[finalIndex] = finalAnswer;
  }

  const anchors = rows.flatMap((row) =>
    row.kind === "user-prompt" && row.chat !== true ? [outlineAnchor(row)] : [],
  );

  // Consecutive prompts from one person share a label, across turns.
  const rowsByTurn = new Map<TranscriptTurnId, ReadonlyArray<TranscriptRow>>();
  let previousRow = base.lastRow;
  for (const [id, turn] of derived) {
    let shown: TranscriptRow[] | undefined;
    turn.rows.forEach((row, index) => {
      if (continuesPrompt(previousRow, row)) {
        const continuedRow = asContinued(row);
        shown ??= [...turn.rows];
        shown[index] = continuedRow;
        const rowIndex = rowIndexById.get(row.id);
        if (rowIndex !== undefined) rows[rowIndex] = continuedRow;
      }
      previousRow = row;
    });
    const priorRows = prior?.rows(id);
    const turnRowsShown = shown ?? turn.rows;
    rowsByTurn.set(
      id,
      priorRows !== undefined && sameItems(priorRows, turnRowsShown)
        ? priorRows
        : turnRowsShown,
    );
  }
  const turns = [...derived.values()].map(({ turn }) => turn);

  // Resume the next derivation where the latest turn began.
  let checkpoint = base;
  if (latest !== undefined && latest.index > base.index) {
    const prefixTurns = turnOrder.slice(0, latest.turns);
    const prefixRows = rows.slice(0, latest.rows);
    const checkpointDerived = new Map(base.derived);
    const checkpointRowsByTurn = new Map(base.rowsByTurn);
    let lastRow = base.lastRow;
    for (const id of prefixTurns) {
      const turn = derived.get(id) as DerivedTurn;
      checkpointDerived.set(id, turn);
      const shown = rowsByTurn.get(id) ?? [];
      checkpointRowsByTurn.set(id, shown);
      lastRow = turn.rows.at(-1) ?? lastRow;
    }
    checkpoint = {
      messages,
      index: latest.index,
      settlements,
      finalOutputs,
      chatEcho,
      walk: latest.walk,
      turnIds: new Set([...base.turnIds, ...prefixTurns]),
      turns: base.turns.concat(turns.slice(0, latest.turns)),
      rows: base.rows.concat(prefixRows),
      outline: base.outline.concat(
        prefixRows.flatMap((row) =>
          row.kind === "user-prompt" && row.chat !== true
            ? [outlineAnchor(row)]
            : [],
        ),
      ),
      derived: checkpointDerived,
      rowsByTurn: checkpointRowsByTurn,
      lastRow,
    };
  } else if (checkpoint.messages !== messages) {
    checkpoint = { ...checkpoint, messages };
  }
  const suffixDerived = new Map<TranscriptTurnId, DerivedTurn>();
  const suffixRowsByTurn = new Map<
    TranscriptTurnId,
    ReadonlyArray<TranscriptRow>
  >();
  for (const [id, turn] of derived)
    if (!checkpoint.turnIds.has(id)) {
      suffixDerived.set(id, turn);
      suffixRowsByTurn.set(id, rowsByTurn.get(id) ?? []);
    }
  return {
    checkpoint,
    rows: base.rows.concat(rows),
    turns: base.turns.concat(turns),
    outline: base.outline.concat(anchors),
    derived: suffixDerived,
    rowsByTurn: suffixRowsByTurn,
  };
};

/**
 * Derives the transcript from Flue history. Given the previous model, it
 * resumes where the latest turn began when the history before it is
 * unchanged, and reuses every row, turn, and anchor whose inputs did not
 * change, so a streamed chunk rebuilds only the turn it changed and the rest
 * of the model keeps its identity.
 */
export const deriveTranscriptViewModel = (
  input: DeriveTranscriptViewModelInput,
  previous?: TranscriptViewModel,
): TranscriptViewModel => {
  const {
    messages,
    settlements,
    finalOutputs = [],
    subagents,
    chatEcho,
  } = input;
  const prior = previous === undefined ? undefined : derivations.get(previous);
  const resumable =
    prior !== undefined &&
    sameItems(prior.checkpoint.settlements, settlements) &&
    sameItems(prior.checkpoint.finalOutputs, finalOutputs) &&
    prior.checkpoint.chatEcho === chatEcho &&
    samePrefix(prior.checkpoint.messages, messages, prior.checkpoint.index)
      ? prior.checkpoint
      : undefined;
  const priorDerivation: PriorDerivation | undefined =
    prior === undefined
      ? undefined
      : {
          turn: (id) =>
            prior.derived.get(id) ?? prior.checkpoint.derived.get(id),
          rows: (id) =>
            prior.rowsByTurn.get(id) ?? prior.checkpoint.rowsByTurn.get(id),
        };
  const derived =
    (resumable === undefined
      ? undefined
      : deriveFrom(resumable, input, priorDerivation)) ??
    (deriveFrom(
      startOfHistory(messages, settlements, finalOutputs, chatEcho),
      input,
      priorDerivation,
    ) as NonNullable<ReturnType<typeof deriveFrom>>);

  const capabilities: TranscriptCapabilities =
    previous !== undefined &&
    (subagents === undefined
      ? !previous.capabilities.subagents.available
      : previous.capabilities.subagents.available &&
        previous.capabilities.subagents.items === subagents)
      ? previous.capabilities
      : {
          paging: { available: false },
          subagents:
            subagents === undefined
              ? { available: false }
              : { available: true, source: "authoritative", items: subagents },
        };
  const side = {
    checkpoint: derived.checkpoint,
    derived: derived.derived,
    rowsByTurn: derived.rowsByTurn,
  };
  const rows =
    previous !== undefined && sameItems(previous.rows, derived.rows)
      ? previous.rows
      : derived.rows;
  const turns =
    previous !== undefined && sameItems(previous.turns, derived.turns)
      ? previous.turns
      : derived.turns;
  const outline =
    previous !== undefined && sameItems(previous.outline, derived.outline)
      ? previous.outline
      : derived.outline;
  if (
    previous !== undefined &&
    previous.rows === rows &&
    previous.turns === turns &&
    previous.outline === outline &&
    previous.capabilities === capabilities
  ) {
    derivations.set(previous, side);
    return previous;
  }
  const model: TranscriptViewModel = { rows, turns, outline, capabilities };
  derivations.set(model, side);
  return model;
};

const rowsByTurnOfModel = new WeakMap<
  TranscriptViewModel,
  ReadonlyMap<TranscriptTurnId, ReadonlyArray<TranscriptRow>>
>();

/**
 * Groups rows by turn once per model instead of searching rows per render.
 * The grouping is kept per model: the transcript reads it in a cache scope
 * that the virtualizer invalidates on every frame.
 */
export const transcriptRowsByTurn = (
  model: TranscriptViewModel,
): ReadonlyMap<TranscriptTurnId, ReadonlyArray<TranscriptRow>> => {
  const known = rowsByTurnOfModel.get(model);
  if (known !== undefined) return known;
  const grouped = groupRowsByTurn(model);
  rowsByTurnOfModel.set(model, grouped);
  return grouped;
};

const groupRowsByTurn = (
  model: TranscriptViewModel,
): ReadonlyMap<TranscriptTurnId, ReadonlyArray<TranscriptRow>> => {
  const derived = derivations.get(model);
  if (derived !== undefined) {
    if (derived.checkpoint.rowsByTurn.size === 0) return derived.rowsByTurn;
    const byTurn = new Map(derived.checkpoint.rowsByTurn);
    for (const [id, rows] of derived.rowsByTurn) byTurn.set(id, rows);
    return byTurn;
  }
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
      a.sourceThreadId !== b.sourceThreadId ||
      a.automation !== b.automation ||
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
    ) &&
    sameIds(a.workDisclosure?.pinnedRowIds, b.workDisclosure?.pinnedRowIds));
