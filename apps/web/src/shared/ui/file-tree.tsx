import type { FileTreeOptions } from "@pierre/trees";
import { FileTree as TreeView, useFileTree } from "@pierre/trees/react";
import { type CSSProperties, useState } from "react";
import { cn } from "../utils.js";
import "./file-tree.css";

/** The Files pane's tree spacing and type (files-tree.tsx); colors in CSS. */
const TREE_STYLE = {
  "--trees-padding-inline-override": "4px",
  "--trees-item-padding-x-override": "6px",
  "--trees-font-size-override": "12px",
} as CSSProperties;

/** The row height of the compact tree (Pierre's compact density). */
const ROW_HEIGHT = 24;

/** How many rows the tree shows with every folder open. */
const rowCount = (paths: ReadonlyArray<string>) => {
  const folders = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1)
      folders.add(segments.slice(0, index).join("/"));
  }
  return folders.size + paths.length;
};

/**
 * A folder tree of relative file paths, drawn by the trees library the
 * Files pane uses (@pierre/trees): folders open, compact rows, the selected
 * file highlighted. Selecting a file calls `onSelect`. Options are read
 * once: give the tree a new `key` when its files change. `fill` sizes it to
 * its container; otherwise it is as tall as its rows, up to `maxRows`.
 */
export function FileTree({
  paths,
  selectedPath,
  onSelect,
  label,
  fill = false,
  maxRows = 24,
  className,
}: {
  readonly paths: ReadonlyArray<string>;
  readonly selectedPath?: string;
  readonly onSelect: (path: string) => void;
  /** Names the tree for assistive tech, such as "pdf files". */
  readonly label: string;
  readonly fill?: boolean;
  readonly maxRows?: number;
  readonly className?: string;
}) {
  const [options] = useState(
    (): FileTreeOptions => ({
      paths: [...paths],
      density: "compact",
      flattenEmptyDirectories: false,
      initialExpansion: "open",
      initialSelectedPaths: selectedPath === undefined ? [] : [selectedPath],
      initialVisibleRowCount: maxRows,
      onSelectionChange: (selection) => {
        const selected = selection.at(-1);
        if (selected !== undefined && !selected.endsWith("/"))
          onSelect(selected);
      },
    }),
  );
  const { model } = useFileTree(options);
  return (
    <div
      className={cn("dx-file-tree", className)}
      data-fill={fill || undefined}
      style={
        fill
          ? TREE_STYLE
          : ({
              ...TREE_STYLE,
              "--file-tree-height": `${Math.min(rowCount(paths), maxRows) * ROW_HEIGHT}px`,
            } as CSSProperties)
      }
    >
      <TreeView aria-label={label} model={model} />
    </div>
  );
}
