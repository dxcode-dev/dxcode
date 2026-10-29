import type {
  ThreadFileData,
  ThreadFilesPath,
  ThreadFileVersion,
} from "@dx/api";
import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@dx/domain";
import {
  Check,
  CloudCheck,
  CloudUpload,
  Code,
  Copy,
  Download,
  EllipsisVertical,
  Eye,
  FolderTree,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  WrapText,
} from "lucide-react";
import * as React from "react";
import { downloadFromUrl } from "../../../shared/download-from-url.js";
import { PaneToolbar } from "../panes/pane-toolbar-slot.js";
import {
  absolutePathFor,
  type FileReveal,
  resolveReveal,
  sandboxFileUrl,
  type ThreadFileTarget,
} from "../transcript-file-link.js";
import type { FileEditorHandle } from "./file-editor.js";
import { ThreadFileEditor } from "./file-editor.js";
import { FilePreview } from "./file-preview.js";
import { filePreviewKind } from "./file-preview-model.js";

type AcceptedEdit = {
  readonly content: string;
  readonly contentVersion: ThreadFileVersion;
};

const acceptedEdit = (
  file: Extract<ThreadFileData, { editable: true }>,
): AcceptedEdit => ({
  content: file.content,
  contentVersion: file.contentVersion,
});

const readonlyMessage = (
  file: Extract<ThreadFileData, { editable: false }>,
) => {
  switch (file.readonlyReason) {
    case "binary":
      return "Binary content cannot be displayed or edited.";
    case "encoding":
      return "This file is not valid UTF-8.";
    case "too-large":
      return "This file exceeds the 256 KiB editing limit.";
  }
};

export const ThreadFileViewer = ({
  file,
  saving,
  conflict,
  connectionError,
  connectionMessage,
  saveError,
  onSave,
  onReload,
  onPreserveLocal,
  onDirtyChange,
  onShowInFiles,
  reveal,
  revealSequence,
  references,
}: {
  readonly file: ThreadFileData;
  /** Where the file lives, so a rendered document's references resolve. */
  readonly references?: {
    readonly threadId: ThreadId;
    readonly location: ThreadFileTarget;
  };
  readonly reveal?: FileReveal;
  readonly revealSequence?: number;
  readonly saving: boolean;
  readonly conflict: boolean;
  readonly connectionError?: boolean;
  readonly connectionMessage?: string;
  readonly saveError?: string;
  readonly onSave: (
    input: {
      readonly path: ThreadFilesPath;
      readonly content: string;
      readonly expectedVersion: ThreadFileVersion;
    },
    callbacks: {
      readonly onSuccess: (saved: {
        readonly contentVersion: ThreadFileVersion;
      }) => void;
      readonly onSettled: () => void;
    },
  ) => void;
  readonly onReload: () => void;
  readonly onPreserveLocal: (
    onSuccess: (file: ThreadFileData) => boolean,
  ) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  /** Brings the Files view forward with this file highlighted. */
  readonly onShowInFiles?: () => void;
}) => {
  // The accepted editing baseline is a transaction snapshot. Background reads
  // must not authorize overwriting a version the user has not accepted.
  const [accepted, setAccepted] = React.useState<AcceptedEdit | null>(null);
  const [content, setContent] = React.useState("");
  const liveContent = React.useRef(file.content);
  const inFlight = React.useRef(false);
  const operation = React.useRef(0);
  const [editorReady, setEditorReady] = React.useState(false);
  const [preserveReadOnly, setPreserveReadOnly] = React.useState(false);
  const [mode, setMode] = React.useState<"preview" | "source" | null>(null);
  const [wrap, setWrap] = React.useState(false);
  const [zen, setZen] = React.useState(false);
  const [mountedEditorVersion, setMountedEditorVersion] =
    React.useState<ThreadFileVersion | null>(() =>
      file.editable ? file.contentVersion : null,
    );
  const editor = React.useRef<FileEditorHandle>(null);
  const editing = accepted !== null || file.editable;
  const displayedContent =
    accepted === null && file.editable ? file.content : content;
  const dirty = accepted !== null && content !== accepted.content;
  const remoteEditorVersion = file.editable ? file.contentVersion : null;
  if (accepted === null && mountedEditorVersion !== remoteEditorVersion)
    setMountedEditorVersion(remoteEditorVersion);
  const remoteChanged =
    accepted !== null &&
    (!file.editable || file.contentVersion !== accepted.contentVersion);
  const previewKind = filePreviewKind(file.path, file.mediaType);
  const previewable = previewKind !== undefined;
  const revealLines = resolveReveal(displayedContent, reveal);
  // A new reveal on an already-open Markdown tab shows the source again, even
  // if the user switched this tab to Preview; ordinary reopening keeps it.
  const [revealedSequence, setRevealedSequence] =
    React.useState(revealSequence);
  if (revealSequence !== revealedSequence) {
    setRevealedSequence(revealSequence);
    if (revealLines !== undefined) setMode("source");
  }
  // A highlighted range is only visible in source; show it there by default.
  const viewMode =
    mode ?? (previewable && revealLines === undefined ? "preview" : "source");
  const change = (next: string) => {
    const currentAccepted =
      accepted ?? (file.editable ? acceptedEdit(file) : null);
    if (currentAccepted === null) return;
    liveContent.current = next;
    const nextDirty = next !== currentAccepted.content;
    if (
      !nextDirty &&
      !inFlight.current &&
      file.editable &&
      file.contentVersion === currentAccepted.contentVersion
    ) {
      setAccepted(null);
      setContent("");
    } else {
      setAccepted(currentAccepted);
      setContent(next);
    }
    onDirtyChange(nextDirty);
  };
  const save = () => {
    if (
      accepted === null ||
      !file.editable ||
      preserveReadOnly ||
      !dirty ||
      saving ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    operation.current += 1;
    onSave(
      {
        path: file.path,
        content,
        expectedVersion: accepted.contentVersion,
      },
      {
        onSuccess: (saved) => {
          setAccepted({
            ...accepted,
            content,
            contentVersion: saved.contentVersion,
          });
          onDirtyChange(liveContent.current !== content);
        },
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };
  const preserveLocal = () => {
    if (saving || inFlight.current) return;
    const request = ++operation.current;
    onPreserveLocal((remote) => {
      if (request !== operation.current) return false;
      setPreserveReadOnly(!remote.editable);
      if (!remote.editable) return false;
      setAccepted(acceptedEdit(remote));
      onDirtyChange(liveContent.current !== remote.content);
      return true;
    });
  };

  return (
    <section
      className="thread-file-viewer"
      data-zen={zen || undefined}
      aria-label={`File ${file.path}`}
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <FileToolbar
        path={file.path}
        previewable={previewable && editing}
        viewMode={viewMode}
        onViewMode={setMode}
        editing={editing}
        editorReady={editorReady}
        dirty={dirty}
        saving={saving}
        saveDisabled={!dirty || saving || !file.editable || preserveReadOnly}
        wrap={wrap}
        zen={zen}
        onSave={() => void save()}
        onFind={() => editor.current?.openFind()}
        onToggleWrap={() => setWrap((value) => !value)}
        onToggleZen={() => setZen((value) => !value)}
        onReload={onReload}
        {...(onShowInFiles === undefined ? {} : { onShowInFiles })}
        {...(connectionMessage === undefined ? {} : { connectionMessage })}
        connectionError={connectionError === true}
        downloadUrl={
          references === undefined
            ? undefined
            : (() => {
                const absolute = absolutePathFor(references.location);
                return absolute === undefined
                  ? undefined
                  : sandboxFileUrl(references.threadId, absolute, true);
              })()
        }
      />
      {conflict || preserveReadOnly || (remoteChanged && !saving) ? (
        <div className="thread-file-notice" role="alert">
          <span>
            {preserveReadOnly || !file.editable
              ? "The remote file is read-only. Your draft is retained; Reload remote discards it."
              : "The file changed remotely. Choose which version to continue with."}
          </span>
          <button
            type="button"
            disabled={!file.editable || saving}
            onClick={() => void preserveLocal()}
          >
            Preserve local
          </button>
          <button type="button" disabled={saving} onClick={onReload}>
            Reload remote
          </button>
        </div>
      ) : null}
      {saveError !== undefined && !conflict ? (
        <div className="thread-file-notice" role="alert">
          {saveError}
        </div>
      ) : null}
      {!editing && !file.editable ? (
        <div className="thread-files-state" role="status">
          <strong>Read-only file</strong>
          <span>{readonlyMessage(file)}</span>
        </div>
      ) : (
        <>
          {/* Mounted only while shown: Source edits must not re-render it. */}
          {previewKind === undefined || viewMode !== "preview" ? null : (
            <FilePreview
              content={displayedContent}
              kind={previewKind}
              path={file.path}
              {...(references === undefined ? {} : { references })}
            />
          )}
          <div
            className="thread-file-source"
            hidden={previewable && viewMode !== "source"}
          >
            <ThreadFileEditor
              content={displayedContent}
              key={`${file.path}:${mountedEditorVersion ?? "read-only"}`}
              path={file.path}
              wrap={wrap}
              onChange={change}
              onReadyChange={setEditorReady}
              ref={editor}
              {...(revealLines === undefined ? {} : { revealLines })}
              {...(revealSequence === undefined ? {} : { revealSequence })}
            />
          </div>
        </>
      )}
    </section>
  );
};

/**
 * The file toolbar, in the pane's tab strip: Preview or Source, Save, and
 * the `⋮` of file actions. The status text stays for assistive tech.
 */
function FileToolbar({
  path,
  previewable,
  viewMode,
  onViewMode,
  editing,
  editorReady,
  dirty,
  saving,
  saveDisabled,
  wrap,
  zen,
  onSave,
  onFind,
  onToggleWrap,
  onToggleZen,
  onReload,
  onShowInFiles,
  connectionMessage,
  connectionError,
  downloadUrl,
}: {
  readonly path: string;
  readonly previewable: boolean;
  readonly viewMode: "preview" | "source";
  readonly onViewMode: (mode: "preview" | "source") => void;
  readonly editing: boolean;
  readonly editorReady: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly saveDisabled: boolean;
  readonly wrap: boolean;
  readonly zen: boolean;
  readonly onSave: () => void;
  readonly onFind: () => void;
  readonly onToggleWrap: () => void;
  readonly onToggleZen: () => void;
  readonly onReload: () => void;
  readonly onShowInFiles?: () => void;
  readonly connectionMessage?: string;
  readonly connectionError: boolean;
  readonly downloadUrl?: string;
}) {
  const other = viewMode === "preview" ? "Source" : "Preview";
  const current = viewMode === "preview" ? "Preview" : "Source";
  return (
    <PaneToolbar className="thread-file-toolbar">
      {connectionMessage === undefined ? null : (
        <span
          className="thread-file-connection"
          role={connectionError ? "alert" : "status"}
        >
          {connectionMessage}
        </span>
      )}
      {previewable ? (
        <button
          type="button"
          className="thread-file-mode"
          aria-label={`${current}, switch to ${other}`}
          onClick={() =>
            onViewMode(viewMode === "preview" ? "source" : "preview")
          }
        >
          {viewMode === "preview" ? (
            <Eye aria-hidden="true" />
          ) : (
            <Code aria-hidden="true" />
          )}
          <span>{current}</span>
        </button>
      ) : null}
      {editing ? (
        <button
          type="button"
          className="thread-file-save"
          aria-label="Save"
          title={saving ? "Saving…" : dirty ? "Save (Ctrl+S)" : "Saved"}
          disabled={saveDisabled}
          onClick={onSave}
        >
          {saving ? (
            <LoaderCircle className="changes-spin" aria-hidden="true" />
          ) : dirty ? (
            <CloudUpload aria-hidden="true" />
          ) : (
            <CloudCheck aria-hidden="true" />
          )}
        </button>
      ) : null}
      <span className="sr-only" role="status">
        {editing ? (dirty ? "Unsaved changes" : "Saved") : ""}
      </span>
      <Menu.Root>
        <Menu.Trigger
          className="thread-file-actions"
          aria-label="File Actions"
          title="File Actions"
        >
          <EllipsisVertical aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            align="end"
            sideOffset={4}
          >
            <Menu.Popup className="thread-menu-popup thread-actions-menu">
              {editing ? (
                <>
                  <Menu.Item
                    className="thread-menu-item"
                    disabled={saveDisabled}
                    onClick={onSave}
                  >
                    <Save />
                    <span>Save</span>
                  </Menu.Item>
                  <Menu.Item className="thread-menu-item" onClick={onToggleZen}>
                    <span>Zen Mode</span>
                    {zen ? <Check /> : null}
                  </Menu.Item>
                  <Menu.Item
                    className="thread-menu-item"
                    disabled={viewMode !== "source" || !editorReady}
                    onClick={onFind}
                  >
                    <Search />
                    <span>Find</span>
                  </Menu.Item>
                  <Menu.Item
                    className="thread-menu-item"
                    onClick={onToggleWrap}
                  >
                    <WrapText />
                    <span>Wrap Lines</span>
                    {wrap ? <Check /> : null}
                  </Menu.Item>
                  <Menu.Item className="thread-menu-item" onClick={onReload}>
                    <RefreshCw />
                    <span>Reload Remote</span>
                  </Menu.Item>
                  <Menu.Separator className="thread-menu-separator" />
                </>
              ) : null}
              {onShowInFiles === undefined ? null : (
                <Menu.Item className="thread-menu-item" onClick={onShowInFiles}>
                  <FolderTree />
                  <span>Show in Files</span>
                </Menu.Item>
              )}
              {downloadUrl === undefined ? null : (
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() => downloadFromUrl(downloadUrl)}
                >
                  <Download />
                  <span>Download</span>
                </Menu.Item>
              )}
              <Menu.Item
                className="thread-menu-item"
                onClick={() => void navigator.clipboard.writeText(path)}
              >
                <Copy />
                <span>Copy Path</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </PaneToolbar>
  );
}
