import type { ThreadSandboxFilePath } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { File } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import * as React from "react";
import { downloadFromUrl } from "../../../shared/download-from-url.js";
import { useTheme } from "../../../shared/theme/theme-provider.js";
import type { CenterFileTab } from "../thread-center-tabs.js";
import {
  absolutePathFor,
  type FileReveal,
  fileMediaKind,
  resolveReveal,
  sandboxFileUrl,
} from "../transcript-file-link.js";
import { ThreadFilePane } from "./files-panel.js";
import { RevealLine } from "./reveal-line.js";
import {
  exceedsPreviewLimit,
  formatBytes,
  sandboxFileMetadataOptions,
  sandboxFilePreviewOptions,
} from "./sandbox-file-queries.js";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The sandbox is unavailable.";

function DownloadCard({
  threadId,
  path,
  title,
  detail,
}: {
  readonly threadId: ThreadId;
  readonly path: ThreadSandboxFilePath;
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="thread-files-state thread-file-download" role="status">
      <strong>{title}</strong>
      <span>{detail}</span>
      <button
        type="button"
        onClick={() => downloadFromUrl(sandboxFileUrl(threadId, path, true))}
      >
        <Download aria-hidden="true" /> Download file
      </button>
    </div>
  );
}

function Toolbar({
  threadId,
  path,
  label,
}: {
  readonly threadId: ThreadId;
  readonly path: ThreadSandboxFilePath;
  readonly label: string;
}) {
  return (
    <header className="thread-file-toolbar">
      <span title={path}>{label}</span>
      <button
        type="button"
        onClick={() => downloadFromUrl(sandboxFileUrl(threadId, path, true))}
      >
        Download
      </button>
      <span role="status">Read-only</span>
    </header>
  );
}

/** Image or video rendered from the streaming route; video fills the pane. */
function SandboxMediaView({
  active,
  threadId,
  path,
  label,
  kind,
}: {
  readonly active: boolean;
  readonly threadId: ThreadId;
  readonly path: ThreadSandboxFilePath;
  readonly label: string;
  readonly kind: "image" | "video";
}) {
  const metadata = useQuery(sandboxFileMetadataOptions(threadId, path, active));
  const [failed, setFailed] = React.useState(false);
  let body: React.ReactNode;
  if (metadata.isPending)
    body = (
      <div className="thread-files-state" role="status">
        Loading file…
      </div>
    );
  else if (metadata.data === undefined)
    body = (
      <div className="thread-files-state" role="alert">
        <span>{errorMessage(metadata.error)}</span>
        <button type="button" onClick={() => void metadata.refetch()}>
          Retry
        </button>
      </div>
    );
  else if (exceedsPreviewLimit(metadata.data.sizeBytes))
    body = (
      <DownloadCard
        threadId={threadId}
        path={path}
        title="This file is too large to preview"
        detail={`${formatBytes(metadata.data.sizeBytes)} exceeds the 100 MiB preview limit.`}
      />
    );
  else if (failed)
    body = (
      <DownloadCard
        threadId={threadId}
        path={path}
        title={`This ${kind} cannot be played in the browser`}
        detail="Download it to open it on your device."
      />
    );
  else if (kind === "image")
    body = (
      <div className="thread-file-media thread-file-media-image">
        <img
          alt={label}
          src={sandboxFileUrl(threadId, path)}
          onError={() => setFailed(true)}
        />
      </div>
    );
  else
    body = (
      <div className="thread-file-media thread-file-media-video">
        {/* biome-ignore lint/a11y/useMediaCaption: sandbox recordings have no caption track. */}
        <video
          controls
          playsInline
          preload="metadata"
          src={sandboxFileUrl(threadId, path)}
          aria-label={label}
          onError={() => setFailed(true)}
        />
      </div>
    );
  return (
    <section className="thread-file-viewer" aria-label={`File ${path}`}>
      <Toolbar threadId={threadId} path={path} label={label} />
      {body}
    </section>
  );
}

/** Read-only text from anywhere in the sandbox, with the edited lines lit. */
function SandboxTextView({
  active,
  threadId,
  path,
  reveal,
  revealSequence,
}: {
  readonly active: boolean;
  readonly threadId: ThreadId;
  readonly path: ThreadSandboxFilePath;
  readonly reveal?: FileReveal;
  readonly revealSequence?: number;
}) {
  const { resolvedAppearance } = useTheme();
  const host = React.useRef<HTMLDivElement>(null);
  const preview = useQuery(sandboxFilePreviewOptions(threadId, path, active));
  const content = preview.data?.kind === "text" ? preview.data.content : "";
  const file = React.useMemo(
    () => ({ name: path, contents: content }),
    [path, content],
  );
  let body: React.ReactNode;
  if (preview.isPending)
    body = (
      <div className="thread-files-state" role="status">
        Loading file…
      </div>
    );
  else if (preview.data === undefined)
    body = (
      <div className="thread-files-state" role="alert">
        <span>{errorMessage(preview.error)}</span>
        <button type="button" onClick={() => void preview.refetch()}>
          Retry
        </button>
      </div>
    );
  else if (preview.data.kind === "download")
    body = (
      <DownloadCard
        threadId={threadId}
        path={path}
        title={
          preview.data.reason === "binary"
            ? "Binary content cannot be displayed"
            : "This file is too large to display"
        }
        detail={formatBytes(preview.data.sizeBytes)}
      />
    );
  else {
    const lines = resolveReveal(content, reveal);
    body = (
      <div className="thread-file-source" ref={host}>
        <File
          file={file}
          disableWorkerPool
          selectedLines={
            lines === undefined ? null : { start: lines.start, end: lines.end }
          }
          options={{
            disableFileHeader: true,
            theme:
              resolvedAppearance === "light" ? "pierre-light" : "pierre-dark",
            themeType: resolvedAppearance,
            overflow: "scroll",
          }}
        />
        {lines === undefined ? null : (
          <RevealLine
            host={host}
            key={`${revealSequence ?? 0}:${lines.start}`}
            line={lines.start}
          />
        )}
      </div>
    );
  }
  return (
    <section className="thread-file-viewer" aria-label={`File ${path}`}>
      <Toolbar threadId={threadId} path={path} label={path} />
      {body}
    </section>
  );
}

/** Render one open center tab by where the file lives and what it contains. */
export function CenterFilePane({
  active,
  file,
  threadId,
  onDirtyChange,
}: {
  readonly active: boolean;
  readonly file: CenterFileTab;
  readonly threadId: ThreadId;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const media = fileMediaKind(file.path);
  const absolute = absolutePathFor(file);
  const reveal = file.reveal;
  const sequence = file.revealSequence;
  if (media !== undefined && absolute !== undefined)
    return (
      <SandboxMediaView
        active={active}
        kind={media}
        label={file.path}
        path={absolute}
        threadId={threadId}
      />
    );
  if (file.kind === "sandbox")
    return (
      <SandboxTextView
        active={active}
        path={file.path}
        threadId={threadId}
        {...(reveal === undefined ? {} : { reveal })}
        {...(sequence === undefined ? {} : { revealSequence: sequence })}
      />
    );
  return (
    <ThreadFilePane
      active={active}
      path={file.path}
      threadId={threadId}
      worktree={file.worktree}
      onDirtyChange={onDirtyChange}
      {...(reveal === undefined ? {} : { reveal })}
      {...(sequence === undefined ? {} : { revealSequence: sequence })}
    />
  );
}
