import { shellCommandOperations } from "./shell-command-operation.js";

const record = (input: unknown): Record<string, unknown> | undefined =>
  typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : undefined;

const stringField = (input: unknown, ...names: ReadonlyArray<string>) => {
  const value = record(input);
  for (const name of names) {
    if (typeof value?.[name] === "string" && value[name].length > 0) {
      return value[name] as string;
    }
  }
  return undefined;
};

const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const humanize = (name: string) =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export const presentTool = (
  toolName: string,
  input: unknown,
  running: boolean,
) => {
  const name = toolName.toLowerCase();
  const path = stringField(input, "path", "filePath", "file_path");
  const command = stringField(input, "command", "cmd");

  if (name === "shell_command" && command) {
    const operations = shellCommandOperations(command);
    if (operations) {
      const first = operations[0];
      if (
        first?.kind === "read" &&
        operations.every((op) => op.kind === "read")
      )
        return {
          title: `${running ? "Reading" : "Read"} ${operations.map((op) => basename(op.path ?? "")).join(", ")}`,
          detail: first.range,
        };
      if (first?.kind === "search")
        return {
          title: running ? "Searching" : "Searched",
          detail: first.pattern,
        };
      if (first?.kind === "list")
        return {
          title: running ? "Listing" : "Listed",
          detail: first.path ?? ".",
        };
      return {
        title: operations
          .map((op) =>
            op.kind === "read"
              ? `${running ? "Reading" : "Read"} ${basename(op.path)}`
              : op.kind === "search"
                ? `${running ? "Searching" : "Searched"} ${op.pattern ?? ""}`
                : `${running ? "Listing" : "Listed"} ${op.path ?? "."}`,
          )
          .join(", "),
        detail: undefined,
      };
    }
  }
  if (name === "web_search")
    return {
      title: running ? "Searching the web" : "Searched the web",
      detail: stringField(input, "objective"),
    };
  if (name === "read_web_page")
    return {
      title: running ? "Reading web page" : "Read web page",
      detail: stringField(input, "url"),
    };
  if (name === "tool_search")
    return {
      title: stringField(input, "query")
        ? running
          ? "Searching tools"
          : "Searched tools"
        : running
          ? "Listing tools"
          : "Listed tools",
      detail: stringField(input, "query"),
    };
  if (name === "code_exec")
    return {
      title: running ? "Executing code" : "Executed code",
      detail: undefined,
    };
  if (name === "create_file" && path)
    return {
      title: `${running ? "Creating" : "Created"} ${basename(path)}`,
      detail: path,
    };
  if (name === "shell_command_status" || name === "shell_command_kill") {
    const pid = record(input)?.pid;
    return {
      title:
        name === "shell_command_status"
          ? running
            ? "Checking command"
            : "Checked command"
          : running
            ? "Stopping command"
            : "Stopped command",
      detail: typeof pid === "number" ? `pid ${pid}` : undefined,
    };
  }
  if (
    name.includes("search") ||
    name.includes("grep") ||
    name.includes("find")
  ) {
    return {
      title: running ? "Searching" : "Searched",
      detail: stringField(input, "query", "pattern"),
    };
  }
  if (name.includes("skill")) {
    return {
      title: running ? "Loading skill" : "Loaded skill",
      detail: stringField(input, "name", "skill"),
    };
  }

  if (
    name === "bash" ||
    name === "shell" ||
    name.includes("command") ||
    name.includes("terminal")
  ) {
    return {
      title: running ? "Running command" : "Ran command",
      detail: command,
    };
  }
  if (
    path !== undefined &&
    (name.includes("write") || name.includes("create"))
  ) {
    return {
      title: `${running ? "Writing" : "Wrote"} ${basename(path)}`,
      detail: path,
    };
  }
  if (path !== undefined && (name.includes("edit") || name.includes("patch"))) {
    return {
      title: `${running ? "Editing" : "Edited"} ${basename(path)}`,
      detail: path,
    };
  }
  if (path !== undefined && (name.includes("read") || name.includes("file"))) {
    return {
      title: `${running ? "Reading" : "Read"} ${basename(path)}`,
      detail: path,
    };
  }
  return { title: humanize(toolName), detail: path ?? command };
};
