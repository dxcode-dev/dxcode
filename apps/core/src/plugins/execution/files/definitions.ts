export const createFileDescription = `Create or overwrite a file in the workspace.

Use this tool to create a **new file** that does not yet exist.

For **existing files**, prefer \`edit_file\` instead—even for extensive changes. Only use \`create_file\` to overwrite an existing file when you are replacing nearly all of its content AND the file is small (under ~250 lines).
`;

export const createFileParameters = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: {
      type: "string",
      description:
        "The absolute path of the file to be created (must be absolute, not relative). If the file exists, it will be overwritten. ALWAYS generate this argument first.",
    },
    content: { type: "string", description: "The content for the file." },
  },
};

export const editFileDescription = `Make edits to a text file.

Replaces \`old_str\` with \`new_str\` in the given file.

Returns a git-style diff showing the changes made as formatted markdown, along with the line range ([startLine, endLine]) of the changed content. The diff is also shown to the user.

The file specified by \`path\` MUST exist, and it MUST be an absolute path. If you need to create a new file, use \`create_file\` instead.

\`old_str\` MUST exist in the file. Use tools like \`Read\` to understand the files you are editing before changing them.

\`old_str\` and \`new_str\` MUST be different from each other.

Set \`replace_all\` to true to replace all occurrences of \`old_str\` in the file. Else, \`old_str\` MUST be unique within the file or the edit will fail. Additional lines of context can be added to make the string more unique.

If you need to replace the entire contents of a file, use \`create_file\` instead, since it requires less tokens for the same action (since you won't have to repeat the contents before replacing).

If you see \`[REDACTED:_____]\` in your inputs and edits fail, dx's secret redaction may have changed the text; ask the user to manually make the edit.
`;

export const editFileParameters = {
  type: "object",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  required: ["path", "old_str", "new_str"],
  properties: {
    path: {
      type: "string",
      description:
        "The absolute path to the file (MUST be absolute, not relative). File must exist. ALWAYS generate this argument first.",
    },
    new_str: { type: "string", description: "Text to replace old_str with." },
    old_str: {
      type: "string",
      description: "Text to search for. Must match exactly.",
    },
    replace_all: {
      type: "boolean",
      default: false,
      description:
        "Set to true to replace all matches of old_str. Else, old_str must be an unique match.",
    },
  },
  additionalProperties: false,
};
