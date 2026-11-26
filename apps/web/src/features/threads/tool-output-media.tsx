import type { ToolPart } from "@dx/client";
import * as React from "react";
import { ImageTiles, type TileImage } from "./message-attachments-ui.js";
import {
  ToolMediaSourceContext,
  toolImages,
} from "./tool-output-media-model.js";

export const useToolImages = (part: ToolPart) =>
  toolImages(part, React.useContext(ToolMediaSourceContext));

/** A tool call's images as tiles under its output. */
export function ToolOutputImages({
  images,
}: {
  readonly images: ReadonlyArray<TileImage>;
}) {
  return (
    <ImageTiles
      images={images}
      label="Images the tool returned"
      className="tool-output-images"
    />
  );
}
