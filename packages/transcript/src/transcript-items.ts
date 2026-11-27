import {
  TRANSCRIPT_WIRE_VERSION,
  type TranscriptItem,
  type TranscriptItemOp,
  type TranscriptPage,
  type TranscriptTurnItem,
} from "@dx/api";
import type { FlueConversationPart } from "@flue/sdk";
import { categoryForPart } from "./transcript-activity-projection.js";
import type {
  TranscriptRow,
  TranscriptViewModel,
} from "./transcript-view-model.js";

/**
 * A transcript view model as wire items: what Core sends a client that does
 * not run the projection itself, and what the web compares its own model
 * with. Both sides call the same function, so a difference is a difference
 * in the model, not in this mapping.
 *
 * Items are lean: a tool's input and output stay on the server, except a
 * preview of the output and its size.
 */

/** Characters of a tool's output an item carries. */
export const OUTPUT_PREVIEW_CHARACTERS = 400;

/** UTF-8 bytes of a string, without TextEncoder, which ES2024 lacks. */
const utf8Bytes = (text: string) => {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const firstString = (value: unknown, keys: ReadonlyArray<string>) => {
  const fields = record(value);
  for (const key of keys) {
    const found = fields?.[key];
    if (typeof found === "string" && found.length > 0) return found;
  }
  return undefined;
};

const oneLine = (text: string, limit = 120) => {
  const line = text.trim().replaceAll(/\s+/gu, " ");
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

type ToolPart = Extract<FlueConversationPart, { type: "dynamic-tool" }>;

/** What the tool did, in one line: its command, path, or query. */
export const toolTitle = (part: ToolPart) => {
  const named = firstString(part.input, [
    "command",
    "cmd",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "description",
    "title",
    "name",
  ]);
  return oneLine(named ?? part.toolName);
};

const outputText = (part: ToolPart) => {
  if (part.state === "output-error") return part.errorText;
  if (part.state !== "output-available") return undefined;
  const { output } = part;
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
};

const toolState = (part: ToolPart): TranscriptItem["state"] =>
  part.state === "output-available"
    ? "done"
    : part.state === "input-available"
      ? "running"
      : "failed";

const rowItem = (row: TranscriptRow): TranscriptItem => {
  const base = { id: row.id, turn: row.turnId };
  switch (row.kind) {
    case "user-prompt":
      return {
        ...base,
        kind: "user-prompt",
        fallback: { title: row.author?.name ?? "Prompt", text: row.text },
        text: row.text,
        ...(row.sentAt === undefined ? {} : { sentAt: row.sentAt }),
        ...(row.author === undefined
          ? {}
          : {
              author: {
                name: row.author.name,
                ...(row.author.handle === undefined
                  ? {}
                  : { handle: row.author.handle }),
                userId: row.author.userId,
                role: row.author.role,
              },
            }),
        ...(row.submissionId === undefined
          ? {}
          : { submissionId: row.submissionId }),
        ...(row.chat === true ? { chat: true } : {}),
        ...(row.continued === true ? { continued: true } : {}),
        ...(row.sourceThreadId === undefined
          ? {}
          : { sourceThreadId: row.sourceThreadId }),
        ...(row.attachments === undefined || row.attachments.length === 0
          ? {}
          : {
              attachments: row.attachments.map((attachment) => ({
                name: attachment.name,
                mediaType: attachment.mimeType,
              })),
            }),
      };
    case "assistant-prose":
    case "final-answer":
      return {
        ...base,
        kind: row.kind === "final-answer" ? "final-answer" : "prose",
        fallback: { text: row.text },
        text: row.text,
        ...(row.streaming ? { streaming: true } : {}),
        ...(row.sentAt === undefined ? {} : { sentAt: row.sentAt }),
      };
    case "attachment":
      return {
        ...base,
        kind: "attachment",
        fallback: {
          title: row.attachment.filename ?? row.attachment.mediaType,
        },
        title: row.attachment.filename ?? row.attachment.mediaType,
        mediaType: row.attachment.mediaType,
      };
    case "active-work":
    case "settled-work": {
      const { part } = row;
      if (part.type === "reasoning")
        return {
          ...base,
          kind: "reasoning",
          fallback: { title: "Thinking" },
          text: part.text,
          ...(part.state === "streaming" ? { streaming: true } : {}),
        };
      if (part.type === "dynamic-tool") {
        const title = toolTitle(part);
        const output = outputText(part);
        return {
          ...base,
          kind: "tool",
          fallback: { title: `${part.toolName}: ${title}` },
          name: part.toolName,
          category: categoryForPart(part),
          title,
          state: toolState(part),
          ...(output === undefined
            ? {}
            : {
                outputPreview: output.slice(0, OUTPUT_PREVIEW_CHARACTERS),
                outputBytes: utf8Bytes(output),
              }),
        };
      }
      return {
        ...base,
        kind: "other",
        fallback: { title: part.type },
        title: part.type,
      };
    }
  }
};

const turnItem = (turn: TranscriptViewModel["turns"][number]) =>
  ({
    id: turn.id,
    status: turn.status,
    ...(turn.durationMs === undefined ? {} : { durationMs: turn.durationMs }),
    ...(turn.finalAnswerRowId === undefined
      ? {}
      : { finalAnswer: turn.finalAnswerRowId }),
    ...(turn.workDisclosure === undefined
      ? {}
      : {
          work: {
            collapsed: [...turn.workDisclosure.collapsedRowIds],
            pinned: [...turn.workDisclosure.pinnedRowIds],
          },
        }),
  }) satisfies TranscriptTurnItem;

/** Items made once per row object, so an unchanged row keeps its item. */
const items = new WeakMap<TranscriptRow, TranscriptItem>();

const itemOf = (row: TranscriptRow) => {
  const known = items.get(row);
  if (known !== undefined) return known;
  const item = rowItem(row);
  items.set(row, item);
  return item;
};

export interface TranscriptItems {
  readonly turns: ReadonlyArray<TranscriptTurnItem>;
  /** In display order: each turn's rows, turn by turn. */
  readonly items: ReadonlyArray<TranscriptItem>;
}

export const transcriptItems = (
  model: TranscriptViewModel,
): TranscriptItems => {
  const rows = new Map(model.rows.map((row) => [row.id, row] as const));
  return {
    turns: model.turns.map(turnItem),
    items: model.turns.flatMap((turn) =>
      turn.rowIds.flatMap((id) => {
        const row = rows.get(id);
        return row === undefined ? [] : [itemOf(row)];
      }),
    ),
  };
};

export const transcriptPage = (
  model: TranscriptViewModel,
  page: { readonly offset: string; readonly olderCursor?: string | null },
): TranscriptPage => ({
  v: TRANSCRIPT_WIRE_VERSION,
  offset: page.offset,
  ...transcriptItems(model),
  ...(page.olderCursor === undefined || page.olderCursor === null
    ? {}
    : { olderCursor: page.olderCursor }),
});

const MERGEABLE = new Set([
  "text",
  "streaming",
  "sentAt",
  "title",
  "state",
  "outputPreview",
  "outputBytes",
  "fallback",
]);

const json = (value: unknown) => JSON.stringify(value);

/** The ops that change one item into another, or undefined when equal. */
const itemOps = (
  before: TranscriptItem,
  after: TranscriptItem,
): ReadonlyArray<TranscriptItemOp> | undefined => {
  if (before === after) return undefined;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys].filter(
    (key) =>
      json(before[key as keyof TranscriptItem]) !==
      json(after[key as keyof TranscriptItem]),
  );
  if (changed.length === 0) return undefined;
  const removed = changed.some((key) => !(key in after));
  if (removed || changed.some((key) => !MERGEABLE.has(key)))
    return [{ op: "upsert", item: after }];
  const ops: TranscriptItemOp[] = [];
  const fields: Record<string, unknown> = {};
  for (const key of changed) {
    const was = before.text ?? "";
    const is = after.text ?? "";
    if (key === "text" && "text" in before && is.startsWith(was))
      ops.push({ op: "append", id: after.id, text: is.slice(was.length) });
    else fields[key] = after[key as keyof TranscriptItem];
  }
  if (Object.keys(fields).length > 0)
    ops.unshift({
      op: "merge",
      id: after.id,
      ...fields,
    } as TranscriptItemOp);
  return ops;
};

/**
 * The ops that change `before` into `after`. Applied in order with
 * `applyTranscriptItemOps`, they give `after` exactly.
 */
export const transcriptItemOps = (
  before: TranscriptItems,
  after: TranscriptItems,
): ReadonlyArray<TranscriptItemOp> => {
  const ops: TranscriptItemOp[] = [];
  const beforeTurns = new Map(before.turns.map((turn) => [turn.id, turn]));
  const afterTurnIds = new Set(after.turns.map((turn) => turn.id));
  for (const turn of before.turns)
    if (!afterTurnIds.has(turn.id))
      ops.push({ op: "remove-turn", id: turn.id });
  for (const turn of after.turns) {
    const known = beforeTurns.get(turn.id);
    if (known === undefined || json(known) !== json(turn))
      ops.push({ op: "turn", turn });
  }
  const beforeItems = new Map(before.items.map((item) => [item.id, item]));
  const afterIds = new Set(after.items.map((item) => item.id));
  const order = before.items.flatMap((item) =>
    afterIds.has(item.id) ? [item.id] : [],
  );
  for (const item of before.items)
    if (!afterIds.has(item.id)) ops.push({ op: "remove", id: item.id });
  for (const item of after.items) {
    const known = beforeItems.get(item.id);
    if (known === undefined) {
      ops.push({ op: "upsert", item });
      order.push(item.id);
      continue;
    }
    ops.push(...(itemOps(known, item) ?? []));
  }
  const ids = after.items.map((item) => item.id);
  if (json(order) !== json(ids)) ops.push({ op: "order", ids });
  return ops;
};

/** Applies ops in order; returns new items, never changing `state`. */
export const applyTranscriptItemOps = (
  state: TranscriptItems,
  ops: ReadonlyArray<TranscriptItemOp>,
): TranscriptItems => {
  const turns = new Map(state.turns.map((turn) => [turn.id, turn]));
  const items = new Map(state.items.map((item) => [item.id, item]));
  let order = state.items.map((item) => item.id);
  for (const op of ops) {
    switch (op.op) {
      case "turn":
        turns.set(op.turn.id, op.turn);
        break;
      case "remove-turn":
        turns.delete(op.id);
        break;
      case "upsert":
        if (!items.has(op.item.id)) order.push(op.item.id);
        items.set(op.item.id, op.item);
        break;
      case "append": {
        const item = items.get(op.id);
        if (item !== undefined)
          items.set(op.id, { ...item, text: `${item.text ?? ""}${op.text}` });
        break;
      }
      case "merge": {
        const item = items.get(op.id);
        if (item !== undefined) {
          const { op: _op, id: _id, ...fields } = op;
          items.set(op.id, { ...item, ...fields });
        }
        break;
      }
      case "remove":
        items.delete(op.id);
        order = order.filter((id) => id !== op.id);
        break;
      case "order":
        order = [...op.ids];
        break;
    }
  }
  return {
    turns: [...turns.values()],
    items: order.flatMap((id) => {
      const item = items.get(id);
      return item === undefined ? [] : [item];
    }),
  };
};

/** JSON with object keys sorted, so key order never counts as a change. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    typeof field === "object" && field !== null && !Array.isArray(field)
      ? Object.fromEntries(
          Object.entries(field).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : field,
  );

/** One way a server projection differs from a client's own. */
export interface TranscriptItemDifference {
  readonly id: string;
  readonly kind: "server-only" | "client-only" | "changed" | "turn-changed";
  /** For `changed`, the fields that differ. */
  readonly fields?: ReadonlyArray<string>;
}

/**
 * A prompt only this client shows: its own unsent echo, a queued message,
 * or a message another Thread sent that Flue has not joined. The server
 * projects Flue's history alone.
 */
const clientOnly = (item: TranscriptItem) =>
  (item.kind === "user-prompt" && item.submissionId === undefined) ||
  item.id.startsWith("row:queued:") ||
  item.id.startsWith("row:inbound:");

/**
 * How `server` differs from `client` over what both hold. The server
 * projects the newest page and the live stream; a client may hold older
 * pages too, so only items of the server's turns count, and the client's
 * own sends are left out.
 */
export const compareTranscriptItems = (
  client: TranscriptItems,
  server: TranscriptItems,
): ReadonlyArray<TranscriptItemDifference> => {
  const differences: TranscriptItemDifference[] = [];
  const serverTurns = new Set(server.turns.map((turn) => turn.id));
  const clientItems = new Map(
    client.items.flatMap((item) =>
      clientOnly(item) ? [] : [[item.id, item] as const],
    ),
  );
  const serverIds = new Set(server.items.map((item) => item.id));
  for (const item of server.items) {
    const mine = clientItems.get(item.id);
    if (mine === undefined) {
      differences.push({ id: item.id, kind: "server-only" });
      continue;
    }
    const keys = new Set([...Object.keys(mine), ...Object.keys(item)]);
    const fields = [...keys].filter(
      (key) =>
        canonical(mine[key as keyof TranscriptItem]) !==
        canonical(item[key as keyof TranscriptItem]),
    );
    if (fields.length > 0)
      differences.push({ id: item.id, kind: "changed", fields });
  }
  for (const [id, item] of clientItems)
    if (serverTurns.has(item.turn) && !serverIds.has(id))
      differences.push({ id, kind: "client-only" });
  const clientTurns = new Map(client.turns.map((turn) => [turn.id, turn]));
  for (const turn of server.turns) {
    const mine = clientTurns.get(turn.id);
    if (mine !== undefined && canonical(mine) !== canonical(turn))
      differences.push({ id: turn.id, kind: "turn-changed" });
  }
  return differences;
};
