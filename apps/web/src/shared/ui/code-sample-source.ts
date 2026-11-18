import type { EditDiffSource } from "./edit-diff.js";

/** A reply's code block: keywords, strings, a comment, numbers, and calls. */
export const codeSampleReply = `\`\`\`ts
import { readFile } from "node:fs/promises";

// Words in a file, up to a limit.
export async function wordCount(path: string, limit = 1000) {
  const text = await readFile(path, "utf8");
  return Math.min(text.split(/\\s+/).length, limit); // 0O 1lI {}[]()
}
\`\`\``;

/** An edit, as a tool call shows it. */
export const codeSampleEdit: EditDiffSource = {
  path: "greet.ts",
  before: `export function greet(name: string) {
  return "Hello, " + name;
}
`,
  after: `export function greet(name: string, excited = false) {
  return \`Hello, \${name}\${excited ? "!" : "."}\`;
}
`,
};
