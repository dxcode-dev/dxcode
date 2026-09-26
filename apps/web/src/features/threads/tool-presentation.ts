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
