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
  | "thread-find"
  | "thread-read"
  | "thread-start"
  | "thread-message"
  | "thread-download"
  | "thread-upload"
  | "thread-changes"
  | "thread-link"
  | "thread-wait"
  | "thread-check"
  | "thread-update"
  | "thread-orbs"
  | "thread-modes"
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
  | "subagent"
  | "generic";

const threadSummaryKinds: Readonly<Record<string, SummaryKind>> = {
  create_thread: "thread-start",
  send_thread_message: "thread-message",
  wait_for_threads: "thread-wait",
  get_thread_status: "thread-check",
  update_thread: "thread-update",
  list_orbs: "thread-orbs",
  list_agent_modes: "thread-modes",
  find_thread: "thread-find",
  read_thread: "thread-read",
  download_thread_file: "thread-download",
  upload_thread_file: "thread-upload",
  download_thread_changes: "thread-changes",
  thread_file_url: "thread-link",
};

/**
 * The Threads one Thread tool call names, counted once per Thread in a
 * summary; a call that names none counts as itself.
 */
export const threadsFor = (part: ToolPart): ReadonlyArray<string> => {
  const fields = record(part.input);
  const listed = fields?.threads;
  if (Array.isArray(listed))
    return listed.filter((id): id is string => typeof id === "string");
  const thread = stringField(part.input, "thread");
  if (thread !== undefined) return [thread];
  // read_thread names its Thread by ID or URL.
  const read = /thr_[0-9a-f-]{36}/.exec(
    stringField(part.input, "threadID") ?? "",
  )?.[0];
  if (read !== undefined) return [read];
  // Only a created Thread is named by the result alone.
  if (part.toolName !== "create_thread") return [];
  const created = stringField(part.output, "threadId");
  return created === undefined ? [] : [created];
};

const summaryKind = (category: ToolCategory, part: ToolPart): SummaryKind => {
  if (category === "subagent") return "subagent";
  const threadKind = threadSummaryKinds[part.toolName];
  if (threadKind !== undefined) return threadKind;
  if (part.toolName === "create_file") return "create";
  if (part.toolName === "web_search") return "web";
  if (part.toolName === "read_web_page") return "page";
  if (part.toolName === "tool_search") return "tools";
  if (part.toolName === "code_exec") return "code";
  if (category === "thread") return "generic";
  if (category !== "explore") return category;
  if (isSearch(part)) return "search";
  return isGuidance(part) ? "guidance" : "read";
};

const summaryPhrase = (kind: SummaryKind, count: number) => {
  switch (kind) {
    case "thread-find":
      return `searched threads ${plural(count, "time")}`;
    case "thread-read":
      return `read ${plural(count, "thread")}`;
    case "thread-start":
      return `started ${plural(count, "thread")}`;
    case "thread-message":
      return `sent ${plural(count, "thread message")}`;
    case "thread-download":
      return `downloaded ${plural(count, "thread file")}`;
    case "thread-upload":
      return `uploaded ${plural(count, "thread file")}`;
    case "thread-changes":
      return `downloaded thread changes ${plural(count, "time")}`;
    case "thread-link":
      return `shared ${plural(count, "file link")}`;
    case "thread-wait":
      return `waited for ${plural(count, "thread")}`;
    case "thread-check":
      return `checked on ${plural(count, "thread")}`;
    case "thread-update":
      return `updated ${plural(count, "thread")}`;
    case "thread-orbs":
      return "listed Orbs";
    case "thread-modes":
      return "listed agent modes";
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
    case "subagent":
      return `ran ${plural(count, "subagent")}`;
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
    // Waiting, checking, and updating count Threads; messages count sends.
    if (
      kind === "thread-wait" ||
      kind === "thread-check" ||
      kind === "thread-update"
    ) {
      const identities = kinds.get(kind) ?? new Set<string>();
      const threads = threadsFor(part);
      for (const thread of threads.length === 0
        ? [`call:${part.toolCallId}`]
        : threads)
        identities.add(thread);
      kinds.set(kind, identities);
      continue;
    }
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
