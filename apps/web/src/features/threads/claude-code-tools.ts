import type { ToolPart } from "./transcript-activity-projection.js";

/**
 * Claude Code mode records Claude Code's own tool calls (Bash, Read, Edit,
 * Write, …) with Claude's input shapes. The transcript presents each one as
 * the dx tool that does the same work, so it reuses dx's command, file,
 * diff, and web renderers. dx's own tools, which Claude calls through the
 * dx MCP server, render as themselves. Flue keeps unchanged parts by
 * reference, so each projection is cached on the part itself to keep row
 * memoization intact.
 */
type Input = Readonly<Record<string, unknown>>;

const record = (value: unknown): Input =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Input)
    : {};

const text = (value: unknown) => (typeof value === "string" ? value : "");

const defined = (entries: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  );

const projections: Record<
  string,
  (input: Input) => { readonly toolName: string; readonly input: Input }
> = {
  Bash: (input) => ({
    toolName: "shell_command",
    input: defined({ command: input.command, description: input.description }),
  }),
  Read: (input) => ({
    toolName: "read",
    input: defined({
      path: input.file_path,
      offset: input.offset,
      limit: input.limit,
    }),
  }),
  Write: (input) => ({
    toolName: "create_file",
    input: defined({ path: input.file_path, content: input.content }),
  }),
  Edit: (input) => ({
    toolName: "edit_file",
    input: defined({
      path: input.file_path,
      old_str: input.old_string,
      new_str: input.new_string,
    }),
  }),
  MultiEdit: (input) => {
    const edits = Array.isArray(input.edits) ? input.edits.map(record) : [];
    return {
      toolName: "edit_file",
      input: defined({
        path: input.file_path,
        old_str: edits.map(({ old_string }) => text(old_string)).join("\n…\n"),
        new_str: edits.map(({ new_string }) => text(new_string)).join("\n…\n"),
      }),
    };
  },
  WebFetch: (input) => ({
    toolName: "read_web_page",
    input: defined({ url: input.url, objective: input.prompt }),
  }),
  WebSearch: (input) => ({
    toolName: "web_search",
    input: defined({ objective: input.query }),
  }),
  Glob: (input) => ({
    toolName: "glob",
    input: defined({ pattern: input.pattern, path: input.path }),
  }),
  Grep: (input) => ({ toolName: "grep", input }),
  /** Calls dx mirrors under one name keep their real Claude tool name. */
  ClaudeCodeTool: (input) => ({
    toolName: text(input.tool) || "ClaudeCodeTool",
    input: record(input.input),
  }),
};

/** Claude's `cat -n` style (`12→text` or `12<TAB>text`) without the numbers. */
const readOutput = (output: unknown) =>
  typeof output === "string" ? output.replace(/^\s*\d+(?:→|\t)/gm, "") : output;

const presented = new WeakMap<ToolPart, ToolPart>();

/** Claude Code names a dx tool `mcp__dx__<name>`; dx ran it as `<name>`. */
const DX_TOOL_PREFIX = "mcp__dx__";

export const presentableToolPart = (part: ToolPart): ToolPart => {
  if (part.toolName.startsWith(DX_TOOL_PREFIX)) {
    const cached = presented.get(part);
    if (cached !== undefined) return cached;
    const next = {
      ...part,
      toolName: part.toolName.slice(DX_TOOL_PREFIX.length),
    } as ToolPart;
    presented.set(part, next);
    return next;
  }
  const project = Object.hasOwn(projections, part.toolName)
    ? projections[part.toolName]
    : undefined;
  if (project === undefined) return part;
  const cached = presented.get(part);
  if (cached !== undefined) return cached;
  const projection = project(record(part.input));
  const next = {
    ...part,
    toolName: projection.toolName,
    input: projection.input,
    ...(part.toolName === "Read" && part.state === "output-available"
      ? { output: readOutput(part.output) }
      : {}),
  } as ToolPart;
  presented.set(part, next);
  return next;
};
