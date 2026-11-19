import { lazyRouteComponent } from "@tanstack/react-router";
import { FileText, Pencil } from "lucide-react";
import * as React from "react";
import { cn } from "../utils.js";
import { Button } from "./button.js";
import { RichMarkdown } from "./rich-markdown.js";
import { SegmentedControl } from "./segmented-control.js";
import "./file-view.css";

const extension = (path: string) => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

// The code view loads with the first file shown as source, not with the
// page. `lazyRouteComponent` reloads the page once if a deploy removed the
// chunk.
const Code = lazyRouteComponent(
  () => import("./file-view-code.js"),
  "FileViewCode",
);

// The editor is the Files pane's (CodeEditor), loaded on first Edit.
const Editor = lazyRouteComponent(
  () => import("./file-view-editor.js"),
  "FileViewEditor",
);

/** Markdown without its YAML front matter, which the source view keeps. */
const withoutFrontMatter = (content: string) =>
  content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");

export type FileViewMode = "preview" | "source";

/**
 * One text file: a header with its path, a note such as its size, and
 * actions, above its content. A Markdown file shows rendered or as source
 * (the header's switch); any other file shows as source in dx's code
 * theme (`CodeFile`). With `onSave`, Edit turns the same view into the
 * Files pane's editor (`CodeEditor`); Save hands it the new text and
 * returns to viewing once it resolves.
 */
export function FileView({
  path,
  content,
  detail,
  actions,
  defaultMode = "preview",
  onSave,
  className,
}: {
  readonly path: string;
  readonly content: string;
  /** A short note beside the path, such as "139 lines · 4 KB". */
  readonly detail?: string;
  readonly actions?: React.ReactNode;
  /** How a Markdown file opens. */
  readonly defaultMode?: FileViewMode;
  /** Makes the file editable; resolves once the new text is saved. */
  readonly onSave?: (content: string) => Promise<unknown>;
  readonly className?: string;
}) {
  const [mode, setMode] = React.useState<FileViewMode>(defaultMode);
  /** The text being edited, or undefined while viewing. */
  const [draft, setDraft] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const editing = draft !== undefined;
  const save = async () => {
    if (onSave === undefined || draft === undefined) return;
    setSaving(true);
    const saved = await onSave(draft).then(
      () => true,
      () => false,
    );
    setSaving(false);
    // A failed save keeps the draft open; the caller says why.
    if (saved) setDraft(undefined);
  };
  const kind = extension(path);
  const markdown = kind === "md" || kind === "markdown" || kind === "mdx";
  const shown = editing ? "edit" : markdown ? mode : "source";
  return (
    <div className={cn("dx-file-view", className)}>
      <header className="dx-file-view-header">
        <FileText aria-hidden />
        <span className="dx-file-view-path">{path}</span>
        {detail === undefined ? null : (
          <span className="dx-file-view-detail">{detail}</span>
        )}
        <span className="dx-file-view-actions">
          {editing ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={saving}
                onClick={() => setDraft(undefined)}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                busy={saving}
                disabled={saving || draft === content}
                onClick={() => void save()}
              >
                Save
              </Button>
            </>
          ) : null}
          {!editing && markdown ? (
            <SegmentedControl
              label="Show file as"
              value={mode}
              onValueChange={setMode}
              options={[
                ["preview", "Preview"],
                ["source", "Source"],
              ]}
            />
          ) : null}
          {!editing && onSave !== undefined ? (
            <Button
              size="xs"
              variant="ghost"
              // Loads the editor while the pointer is on its way to Edit.
              onPointerEnter={() => void Editor.preload?.()}
              onFocus={() => void Editor.preload?.()}
              onClick={() => setDraft(content)}
            >
              <Pencil aria-hidden /> Edit
            </Button>
          ) : null}
          {actions}
        </span>
      </header>
      <section
        className="dx-file-view-body"
        data-mode={shown}
        aria-label={`${path}, ${shown}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the file must scroll from the keyboard.
        tabIndex={0}
      >
        {editing ? (
          <React.Suspense
            fallback={<pre className="dx-file-view-plain">{content}</pre>}
          >
            <Editor path={path} content={content} onChange={setDraft} />
          </React.Suspense>
        ) : shown === "preview" ? (
          <RichMarkdown document>{withoutFrontMatter(content)}</RichMarkdown>
        ) : (
          <React.Suspense
            fallback={<pre className="dx-file-view-plain">{content}</pre>}
          >
            <Code path={path} content={content} />
          </React.Suspense>
        )}
      </section>
    </div>
  );
}
