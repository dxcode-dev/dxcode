import type { FlueConversationPart } from "@flue/react";
import type { TranscriptRow } from "./transcript-view-model.js";

export type WorkRow = Extract<
  TranscriptRow,
  { readonly kind: "active-work" | "settled-work" }
>;
export type ToolPart = Extract<
  FlueConversationPart,
  { readonly type: "dynamic-tool" }
>;
export type ToolCategory = "check" | "command" | "edit" | "explore" | "generic";

export type TranscriptActivity =
  | { readonly kind: "row"; readonly row: TranscriptRow }
  | {
      readonly kind: "tools";
      readonly category: ToolCategory;
      readonly rows: ReadonlyArray<WorkRow>;
    };

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const hasCommand = (input: unknown) => {
  const fields = record(input);
  return (
    (typeof fields?.command === "string" && fields.command.length > 0) ||
    (typeof fields?.cmd === "string" && fields.cmd.length > 0)
  );
};

export const toolPart = (row: WorkRow): ToolPart | undefined =>
  row.part.type === "dynamic-tool" ? row.part : undefined;

export const categoryForTool = (
  toolName: string,
  input: unknown,
): ToolCategory => {
  const name = toolName.toLowerCase();
  if (
    name.includes("poll") ||
    name.includes("check") ||
    name.includes("status") ||
    name.includes("wait") ||
    name.includes("process")
  ) {
    return "check";
  }
  if (
    name === "bash" ||
    name === "shell" ||
    name === "exec" ||
    name === "run" ||
    name.includes("command") ||
    name.includes("terminal") ||
    hasCommand(input)
  ) {
    return "command";
  }
  if (
    name.includes("edit") ||
    name.includes("patch") ||
    name.includes("write") ||
    name.includes("create")
  ) {
    return "edit";
  }
  if (
    name.includes("read") ||
    name.includes("file") ||
    name.includes("search") ||
    name.includes("grep") ||
    name.includes("find") ||
    name.includes("glob") ||
    name.includes("list") ||
    name.includes("skill")
  ) {
    return "explore";
  }
  return "generic";
};

const categoryFor = (part: ToolPart): ToolCategory =>
  categoryForTool(part.toolName, part.input);

const workRow = (row: TranscriptRow): WorkRow | undefined =>
  row.kind === "active-work" || row.kind === "settled-work" ? row : undefined;

export const projectTranscriptActivities = (
  rows: ReadonlyArray<TranscriptRow>,
): ReadonlyArray<TranscriptActivity> => {
  const activities: TranscriptActivity[] = [];
  const visibleRows = rows.filter((row) => {
    const work = workRow(row);
    return work?.part.type !== "reasoning";
  });

  const appendTools = (category: ToolCategory, groupedRows: WorkRow[]) => {
    const previous = activities.at(-1);
    const groupable =
      category === "explore" || category === "command" || category === "check";
    if (
      groupable &&
      previous?.kind === "tools" &&
      previous.category === category
    ) {
      activities[activities.length - 1] = {
        ...previous,
        rows: [...previous.rows, ...groupedRows],
      };
      return;
    }
    activities.push({ kind: "tools", category, rows: groupedRows });
  };

  for (let index = 0; index < visibleRows.length; ) {
    const row = visibleRows[index];
    if (row === undefined) break;
    const work = workRow(row);
    const part = work === undefined ? undefined : toolPart(work);
    if (work === undefined || part === undefined) {
      activities.push({ kind: "row", row });
      index += 1;
      continue;
    }

    const messageRows: WorkRow[] = [];
    let cursor = index;
    while (cursor < visibleRows.length) {
      const candidate = visibleRows[cursor];
      if (candidate === undefined || candidate.messageId !== row.messageId)
        break;
      const candidateWork = workRow(candidate);
      if (candidateWork === undefined || toolPart(candidateWork) === undefined)
        break;
      messageRows.push(candidateWork);
      cursor += 1;
    }

    const buckets = new Map<ToolCategory, WorkRow[]>();
    for (const messageRow of messageRows) {
      const messagePart = toolPart(messageRow);
      if (messagePart === undefined) continue;
      const category = categoryFor(messagePart);
      const bucket = buckets.get(category);
      if (bucket === undefined) buckets.set(category, [messageRow]);
      else bucket.push(messageRow);
    }
    for (const [category, groupedRows] of buckets)
      appendTools(category, groupedRows);
    index = cursor;
  }
  return activities;
};

export const terminalToolActivityRowIds = (
  rows: ReadonlyArray<TranscriptRow>,
): ReadonlyArray<TranscriptRow["id"]> => {
  const terminalRows: WorkRow[] = [];
  let terminalCategory: ToolCategory | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const work = workRow(row);
    if (work === undefined) {
      if (terminalRows.length > 0) break;
      continue;
    }
    if (work.part.type === "reasoning") continue;
    const part = toolPart(work);
    if (part === undefined) {
      if (terminalRows.length > 0) break;
      continue;
    }
    const category = categoryFor(part);
    if (terminalCategory === undefined) terminalCategory = category;
    if (category !== terminalCategory) break;
    terminalRows.unshift(work);
  }
  return terminalRows.map((row) => row.id);
};
