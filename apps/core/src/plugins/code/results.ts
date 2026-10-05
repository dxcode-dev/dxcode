import type {
  CallToolResult,
  JsonSchemaType,
} from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";

const preview = (value: unknown) =>
  JSON.stringify(value)?.slice(0, 2_000) ?? "undefined";

/** Raw bypasses only tool-result errors and output validation, never transport. */
export const mcpResultValue = (
  result: CallToolResult,
  outputSchema?: JsonSchemaType,
  raw = false,
): unknown => {
  if (raw) return result;
  if (result.isError) throw new Error(`MCP tool failed: ${preview(result)}`);
  if (outputSchema !== undefined) {
    try {
      if (result.structuredContent === undefined)
        throw new Error("Missing structuredContent required by outputSchema");
      const validation = new CfWorkerJsonSchemaValidator().getValidator(
        outputSchema,
      )(result.structuredContent);
      if (!validation.valid) throw new Error(JSON.stringify(validation));
    } catch (error) {
      throw new Error(
        `MCP outputSchema validation failed: ${error instanceof Error ? error.message : String(error)}; preview: ${preview(result)}`,
      );
    }
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
