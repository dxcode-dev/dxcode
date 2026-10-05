export const CODE_EXEC_TOOL = {
  name: "code_exec",
  description: `Run JavaScript that calls deferred dx tools and functions from the user's connected MCP servers. Find functions with tool_search first.

Rules:
- Import functions with bare module specifiers: import { create_issue } from "linear"
- Every imported function returns a Promise; use top-level await.
- Normal calls return the server's structuredContent when present, otherwise parsed JSON text or plain text. If the server reports a tool failure (isError: true), await throws a JavaScript error with the server's error details. If a successful response is missing structuredContent required by outputSchema or does not match that schema, await throws with validation details and a bounded data preview. Use try/catch to handle these errors; uncaught errors fail code_exec.
- Use an imported function's .raw(input) instead to receive the complete MCP response even when the server reports a tool failure or the output schema is violated. Raw calls skip output-schema validation, not transport or authentication errors. When structured data and text are both present, one raw call gives you both: result.structuredContent and result.content (text blocks have type: "text" and a text field; resource links and other blocks are preserved too).
- Each normal or .raw(input) call invokes the tool anew; .raw does not retrieve a previous call's response. If you need both data and text, call .raw once and read both fields. After an error, inspect its preview before considering another call; do not repeat side-effecting operations merely to retrieve raw output.
- When a function takes source code as a string argument, pass an ordinary function instead, such as execute({ code: async () => { ... } }). dx sends the function's source text, so the inner code needs no quoting or escaping. The function runs in the other tool's runtime, so it cannot use variables from this code; write values such as IDs inline.
- Output via text(value) or content(value); there is no console and the completion value is discarded. text() prints strings as-is and renders arrays and objects as readable Markdown. content(value: ContentBlock | ContentBlock[]): void emits MCP text blocks ({ type: "text", text: string }) and image blocks ({ type: "image", data: string, mimeType: string }) as private thread attachments, and silently ignores other block types. Use content(result.content) on a raw result.
- Use shapeOf(value) to inspect unfamiliar nested results. It returns a recursive schema describing the observed structure.
- tool_search(query) and tool_describe("module.function") also work as globals inside the code, for discovering more functions without another turn.
- This is NOT a general-purpose runtime: no filesystem, network, workspace access, Node APIs, or state between runs. The imported functions are the only capabilities. Use other tools for shell or file work.

Example:
import { list_issues, create_issue } from "linear"
const open = await list_issues({ state: "open" })
text(open)`,
  parameter:
    "JavaScript source. Bare module imports, top-level await, output via text().",
} as const;

export const TOOL_SEARCH_TOOL = {
  name: "tool_search",
  description: `Search deferred dx tools and functions from the user's connected MCP servers, presented as importable JavaScript modules.

Results are import statements plus TypeScript signatures. The functions are NOT directly callable tools — run them by writing code with code_exec.

- Query with capability keywords, e.g. "create issue" or "list calendar events".
- Pass an exact "module.function" name to get the full parameter types for one function.
- Pass an empty query to list all available modules.

Available modules:`,
  parameter:
    'Capability keywords, an exact "module.function" name, or empty to list all modules.',
} as const;
