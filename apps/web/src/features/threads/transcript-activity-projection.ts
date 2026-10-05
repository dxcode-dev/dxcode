import type { FlueConversationPart } from "@flue/react";
import { shellCommandOperations } from "./shell-command-operation.js";
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
      /** Consecutive tool calls in chronological order, across categories. */
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
  if (name === "code_exec") return "generic";
  if (
    name === "web_search" ||
    name === "read_web_page" ||
    name === "tool_search"
  )
    return "explore";
  if (
    name === "shell_command" &&
    typeof record(input)?.command === "string" &&
    shellCommandOperations(record(input)?.command as string)
  )
    return "explore";
  if (
    name === "shell_command_kill" ||
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

const workRow = (row: TranscriptRow): WorkRow | undefined =>
  row.kind === "active-work" || row.kind === "settled-work" ? row : undefined;

export const categoryForPart = (part: ToolPart): ToolCategory =>
  categoryForTool(part.toolName, part.input);

/**
 * Collapse each uninterrupted run of tool calls into one activity so the
 * summary reflects every kind of work in the order it happened.
 */
export const projectTranscriptActivities = (
  rows: ReadonlyArray<TranscriptRow>,
): ReadonlyArray<TranscriptActivity> => {
  const activities: TranscriptActivity[] = [];
  for (const row of rows) {
    const work = workRow(row);
    if (work?.part.type === "reasoning") continue;
    if (work === undefined || toolPart(work) === undefined) {
      activities.push({ kind: "row", row });
      continue;
    }
    const previous = activities.at(-1);
    if (previous?.kind === "tools")
      activities[activities.length - 1] = {
        kind: "tools",
        rows: [...previous.rows, work],
      };
    else activities.push({ kind: "tools", rows: [work] });
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
    const category = categoryForPart(part);
    if (terminalCategory === undefined) terminalCategory = category;
    if (category !== terminalCategory) break;
    terminalRows.unshift(work);
  }
  return terminalRows.map((row) => row.id);
};
