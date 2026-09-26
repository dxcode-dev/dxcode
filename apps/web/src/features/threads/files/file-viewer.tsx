import type {
  ThreadFileData,
  ThreadFilesPath,
  ThreadFileVersion,
} from "@dx/api";
import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileEditorHandle } from "./file-editor.js";
import { ThreadFileEditor } from "./file-editor.js";

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
}: {
  readonly file: ThreadFileData;
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
  const markdown = file.mediaType === "text/markdown";
  const viewMode = mode ?? (markdown ? "preview" : "source");
  const change = React.useCallback(
    (next: string) => {
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
    },
    [accepted, file, onDirtyChange],
  );
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
      <header className="thread-file-toolbar">
        <span title={file.path}>{file.path}</span>
        {markdown && editing ? (
          <div role="tablist" aria-label="File view mode">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "preview"}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "source"}
              onClick={() => setMode("source")}
            >
              Source
            </button>
          </div>
        ) : null}
        {editing ? (
          <>
            <button
              type="button"
              disabled={viewMode !== "source" || !editorReady}
              onClick={() => editor.current?.openFind()}
            >
              Find
            </button>
            <button
              type="button"
              aria-pressed={wrap}
              onClick={() => setWrap((value) => !value)}
            >
              Wrap
            </button>
            <button
              type="button"
              aria-pressed={zen}
              onClick={() => setZen((value) => !value)}
            >
              {zen ? "Exit Zen" : "Zen"}
            </button>
            <button
              type="button"
              disabled={!dirty || saving || !file.editable || preserveReadOnly}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : null}
        <span role="status">
          {editing ? (dirty ? "Unsaved changes" : "Saved") : ""}
        </span>
      </header>
      {connectionMessage === undefined ? null : (
        <div
          className="thread-file-notice"
          role={connectionError ? "alert" : "status"}
        >
          {connectionMessage}
        </div>
      )}
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
        <div className="thread-file-notice" role="status">
          <strong>Read-only file</strong>
          <span>{readonlyMessage(file)}</span>
        </div>
      ) : (
        <>
          {markdown ? (
            <article
              className="thread-file-preview"
              hidden={viewMode !== "preview"}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayedContent}
              </ReactMarkdown>
            </article>
          ) : null}
          <div
            className="thread-file-source"
            hidden={markdown && viewMode !== "source"}
          >
            <ThreadFileEditor
              content={displayedContent}
              key={`${file.path}:${mountedEditorVersion ?? "read-only"}`}
              path={file.path}
              wrap={wrap}
              onChange={change}
              onReadyChange={setEditorReady}
              ref={editor}
            />
          </div>
        </>
      )}
    </section>
  );
};
