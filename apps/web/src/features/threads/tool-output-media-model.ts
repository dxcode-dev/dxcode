import { createContext } from "react";
import type { TileImage } from "./message-attachments-ui.js";
import type { ToolPart } from "./transcript-activity-projection.js";
import { record, stringField } from "./transcript-activity-summary.js";

/** The same-origin URL of an image a tool call returned, by its Flue id. */
export const ToolMediaSourceContext = createContext<
  ((attachmentId: string) => string) | undefined
>(undefined);

/**
 * A tool result's content blocks: Flue records a result with an image as
 * the blocks themselves, and some tools wrap them in `{ content }`.
 */
export const toolContentBlocks = (output: unknown) => {
  const content = Array.isArray(output) ? output : record(output)?.content;
  return Array.isArray(content)
    ? content.flatMap((item) => {
        const block = record(item);
        return block === undefined ? [] : [block];
      })
    : undefined;
};

/** Claude Code's stand-in for an image it did not hand over. */
const IMAGE_PLACEHOLDER = "[image]";

/** A result's text blocks, without image stand-ins. */
export const toolContentText = (output: unknown) => {
  const text = (toolContentBlocks(output) ?? []).flatMap((block) =>
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim() !== IMAGE_PLACEHOLDER
      ? [block.text]
      : [],
  );
  return text.length > 0 ? text.join("\n") : undefined;
};

const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/**
 * The images a finished tool call returned. Flue stores each one as an
 * attachment of the Thread's conversation and records its id in place of
 * the bytes; a result not yet stored still holds base64.
 */
export const toolImages = (
  part: ToolPart,
  source: ((attachmentId: string) => string) | undefined,
): TileImage[] => {
  if (part.state !== "output-available") return [];
  const path = stringField(part.input, "path", "file_path");
  const name = path === undefined ? "Image" : basename(path);
  return (toolContentBlocks(part.output) ?? []).flatMap((block, index) => {
    if (block.type !== "image" || typeof block.data !== "string") return [];
    const mimeType =
      typeof block.mimeType === "string" ? block.mimeType : "image/png";
    const url = block.data.startsWith("att_")
      ? source?.(block.data)
      : `data:${mimeType};base64,${block.data}`;
    return url === undefined
      ? []
      : [{ key: `${index}:${block.data.slice(0, 64)}`, url, name }];
  });
};
