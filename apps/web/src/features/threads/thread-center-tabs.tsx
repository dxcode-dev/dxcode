import { X } from "lucide-react";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import {
  type FileReveal,
  fileTargetKey,
  type ThreadFileTarget,
} from "./transcript-file-link.js";

/** An open file in the center pane: a repository or read-only sandbox file. */
export type CenterFileTab = ThreadFileTarget & {
  readonly dirty: boolean;
  /** Lines to highlight; replaced each time the file is opened again. */
  readonly reveal?: FileReveal;
  /** Increments per open so the same reveal can scroll again. */
  readonly revealSequence?: number;
};

export const centerTabKey = (file: ThreadFileTarget) => fileTargetKey(file);

const worktreeLabel = (file: CenterFileTab) =>
  file.kind === "workspace" ? file.worktreeLabel : "Sandbox";

const filename = (path: string) => path.split("/").at(-1) ?? path;

export const ThreadCenterTabs = ({
  files,
  activeFile,
  onSelect,
  onClose,
}: {
  readonly files: readonly CenterFileTab[];
  readonly activeFile?: string;
  readonly onSelect: (key?: string) => void;
  readonly onClose: (file: CenterFileTab) => void;
}) => {
  if (files.length === 0) return null;
  const close = (file: CenterFileTab) => {
    if (
      file.dirty &&
      !window.confirm(`Discard unsaved changes to ${filename(file.path)}?`)
    )
      return;
    onClose(file);
  };
  return (
    <div className="thread-center-tab-strip">
      <div
        className="thread-center-tabs"
        role="tablist"
        aria-label="Thread panes"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeFile === undefined}
          className="thread-center-tab"
          onClick={() => onSelect()}
        >
          <OrbIcon aria-hidden="true" /> Agent
        </button>
        {files.map((file) => {
          const key = centerTabKey(file);
          const tabWorktreeLabel = worktreeLabel(file);
          const label = `${filename(file.path)}${
            tabWorktreeLabel === undefined ? "" : ` — ${tabWorktreeLabel}`
          }`;
          const locationLabel =
            tabWorktreeLabel === undefined || file.kind === "sandbox"
              ? file.path
              : `${tabWorktreeLabel}: ${file.path}`;
          return (
            <div
              className="thread-center-file-tab"
              role="presentation"
              key={key}
            >
              <button
                type="button"
                role="tab"
                aria-label={`${label}${file.dirty ? " (unsaved)" : ""}`}
                aria-selected={activeFile === key}
                className="thread-center-tab"
                title={locationLabel}
                onClick={() => onSelect(key)}
              >
                {filename(file.path)}
                {tabWorktreeLabel === undefined ? null : (
                  <span className="thread-center-tab-worktree">
                    {tabWorktreeLabel}
                  </span>
                )}
                {file.dirty ? <span aria-hidden="true"> •</span> : null}
              </button>
              <button
                type="button"
                className="thread-center-tab-close"
                aria-label={`Close ${locationLabel}`}
                onClick={() => close(file)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
