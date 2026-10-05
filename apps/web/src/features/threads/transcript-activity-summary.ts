import { shellCommandOperations } from "./shell-command-operation.js";
import {
  categoryForPart,
  type ToolCategory,
  type ToolPart,
  toolPart,
  type WorkRow,
} from "./transcript-activity-projection.js";

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

export const stringField = (
  value: unknown,
  ...names: ReadonlyArray<string>
) => {
  const fields = record(value);
  for (const name of names) {
    const candidate = fields?.[name];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

export const pathFor = (part: ToolPart) =>
  stringField(part.input, "path", "filePath", "file_path");
export const commandFor = (part: ToolPart) =>
  stringField(part.input, "command", "cmd") ??
  (typeof record(part.input)?.pid === "number"
    ? `pid ${record(part.input)?.pid}`
    : undefined);

export const isSearch = (part: ToolPart) => {
  const name = part.toolName.toLowerCase();
  return ["search", "grep", "find", "glob", "list"].some((token) =>
    name.includes(token),
  );
};

const isGuidance = (part: ToolPart) => {
  const name = part.toolName.toLowerCase();
  const path = pathFor(part)?.toLowerCase();
  return (
    name.includes("skill") ||
    path?.endsWith("agents.md") === true ||
    path?.endsWith("skill.md") === true
  );
};

type SummaryKind =
  | "create"
  | "list"
  | "web"
  | "page"
  | "tools"
  | "code"
  | "command"
  | "edit"
  | "read"
  | "guidance"
  | "search"
  | "check"
  | "generic";

const summaryKind = (category: ToolCategory, part: ToolPart): SummaryKind => {
  if (part.toolName === "create_file") return "create";
  if (part.toolName === "web_search") return "web";
  if (part.toolName === "read_web_page") return "page";
  if (part.toolName === "tool_search") return "tools";
  if (part.toolName === "code_exec") return "code";
  if (category !== "explore") return category;
  if (isSearch(part)) return "search";
  return isGuidance(part) ? "guidance" : "read";
};

const summaryPhrase = (kind: SummaryKind, count: number) => {
  switch (kind) {
    case "create":
      return `created ${plural(count, "file")}`;
    case "list":
      return `listed ${plural(count, "directory", "directories")}`;
    case "web":
      return `searched the web ${plural(count, "time")}`;
    case "page":
      return `read ${plural(count, "web page")}`;
    case "tools":
      return `searched tools ${plural(count, "time")}`;
    case "code":
      return `executed code ${plural(count, "time")}`;
    case "command":
      return `ran ${plural(count, "command")}`;
    case "edit":
      return `edited ${plural(count, "file")}`;
    case "read":
      return `read ${plural(count, "file")}`;
    case "guidance":
      return `read ${plural(count, "guidance file")}`;
    case "search":
      return `searched ${plural(count, "time")}`;
    case "check":
      return `checked on ${plural(count, "command")}`;
    case "generic":
      return `used ${plural(count, "tool")}`;
  }
};

/**
 * Summarize a run of tool calls by kind, in order of first appearance:
 * "Ran 2 commands, edited 3 files". Edits and reads count distinct files.
 */
export const activitySummary = (rows: ReadonlyArray<WorkRow>) => {
  const kinds = new Map<SummaryKind, Set<string>>();
  for (const row of rows) {
    const part = toolPart(row);
    if (part === undefined) continue;
    const operations =
      part.toolName === "shell_command"
        ? shellCommandOperations(commandFor(part) ?? "")
        : undefined;
    if (operations) {
      for (const [index, operation] of operations.entries()) {
        const kind = operation.kind;
        const identities = kinds.get(kind) ?? new Set<string>();
        identities.add(
          kind === "read"
            ? `path:${operation.path}`
            : `call:${part.toolCallId}:${index}`,
        );
        kinds.set(kind, identities);
      }
      continue;
    }
    const kind = summaryKind(categoryForPart(part), part);
    const path =
      kind === "page" ? stringField(part.input, "url") : pathFor(part);
    const identity =
      (kind === "edit" ||
        kind === "create" ||
        kind === "page" ||
        kind === "read" ||
        kind === "guidance") &&
      path !== undefined
        ? `path:${path}`
        : `call:${part.toolCallId}`;
    const identities = kinds.get(kind) ?? new Set<string>();
    identities.add(identity);
    kinds.set(kind, identities);
  }
  const label = [...kinds]
    .map(([kind, identities]) => summaryPhrase(kind, identities.size))
    .join(", ");
  return label.charAt(0).toUpperCase() + label.slice(1);
};
