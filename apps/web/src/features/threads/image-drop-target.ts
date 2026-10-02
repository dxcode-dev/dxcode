import * as React from "react";

const carriesFiles = (dataTransfer: DataTransfer | null) =>
  dataTransfer !== null && [...dataTransfer.types].includes("Files");

export interface ImageDropTargetProps {
  readonly "data-file-drop-active"?: "true";
  readonly onDragEnter: (event: React.DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: React.DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: React.DragEvent<HTMLElement>) => void;
}

/**
 * Turns a composer surface into a drop target for dragged files. Text drags
 * keep the browser's default behavior; file drags never navigate away, and
 * dropped files reach the same handler as the file picker.
 */
export function useImageDropTarget({
  disabled = false,
  onFiles,
}: {
  readonly disabled?: boolean;
  readonly onFiles: (files: ReadonlyArray<File>) => void;
}): ImageDropTargetProps {
  const [active, setActive] = React.useState(false);
  const accept = (event: React.DragEvent<HTMLElement>) => {
    if (!carriesFiles(event.dataTransfer)) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    return !disabled;
  };
  return {
    ...(active ? { "data-file-drop-active": "true" as const } : {}),
    onDragEnter: (event) => setActive(accept(event)),
    onDragOver: (event) => {
      if (accept(event) !== active) setActive(!active);
    },
    onDragLeave: (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setActive(false);
    },
    onDrop: (event) => {
      const accepted = accept(event);
      setActive(false);
      if (!accepted) return;
      const files = [...event.dataTransfer.files];
      if (files.length > 0) onFiles(files);
    },
  };
}
