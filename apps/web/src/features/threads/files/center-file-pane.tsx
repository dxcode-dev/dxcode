import type { ThreadSandboxFilePath } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { File } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { AudioLines, Copy, Download, EllipsisVertical } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import * as React from "react";
import { downloadFromUrl } from "../../../shared/download-from-url.js";
import { useTheme } from "../../../shared/theme/theme-provider.js";
import {
  type FileMediaKind,
  fileMediaKind,
} from "../../../shared/ui/media-kind.js";
import type { CenterFileTab } from "./file-tab.js";
import {
  absolutePathFor,
  type FileReveal,
  resolveReveal,
  sandboxFileUrl,
} from "../transcript-file-link.js";
import { PaneToolbar } from "../panes/pane-toolbar-slot.js";
import { FilePreview } from "./file-preview.js";
import { filePreviewKind } from "./file-preview-model.js";
import { ThreadFilePane } from "./files-panel.js";
import { RevealLine } from "./reveal-line.js";
import {
  exceedsPreviewLimit,
  formatBytes,
  SandboxPdfInvalid,
  sandboxFileMetadataOptions,
  sandboxFilePreviewOptions,
  sandboxPdfOptions,
  showBlobInFrame,
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

/** A read-only sandbox file's actions, in the pane's tab strip. */
function Toolbar({
  threadId,
  path,
  children,
}: {
  readonly threadId: ThreadId;
  readonly path: ThreadSandboxFilePath;
  readonly label: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <PaneToolbar className="thread-file-toolbar">
      {children}
      <span className="sr-only" role="status">
        Read-only
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
              <Menu.Item
                className="thread-menu-item"
                onClick={() =>
                  downloadFromUrl(sandboxFileUrl(threadId, path, true))
                }
              >
                <Download />
                <span>Download</span>
              </Menu.Item>
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

/**
 * The sandbox route forbids rendering its responses as documents, so the
 * browser's PDF viewer reads a local copy for as long as the frame shows it.
 */
function PdfFrame({
  blob,
  label,
}: {
  readonly blob: Blob;
  readonly label: string;
}) {
  const attach = (frame: HTMLIFrameElement | null) =>
    frame === null ? undefined : showBlobInFrame(frame, blob);
  return <iframe className="thread-file-pdf" ref={attach} title={label} />;
}

function PdfView({
  active,
  threadId,
  path,
  label,
  version,
}: {
  readonly active: boolean;
  readonly threadId: ThreadId;
  readonly path: ThreadSandboxFilePath;
  readonly label: string;
  readonly version: string | undefined;
}) {
  const pdf = useQuery(sandboxPdfOptions(threadId, path, version, active));
  if (pdf.data !== undefined)
    return (
      <div className="thread-file-media thread-file-media-pdf">
        <PdfFrame blob={pdf.data} label={label} />
      </div>
    );
  if (pdf.isPending)
    return (
      <div className="thread-files-state" role="status">
        Loading file…
      </div>
    );
  if (pdf.error instanceof SandboxPdfInvalid)
    return (
      <DownloadCard
        threadId={threadId}
        path={path}
        title="This PDF cannot be displayed"
        detail="Download it to open it on your device."
      />
    );
  return (
    <div className="thread-files-state" role="alert">
      <span>{errorMessage(pdf.error)}</span>
      <button type="button" onClick={() => void pdf.refetch()}>
        Retry
      </button>
    </div>
  );
}

const mediaNoun = { image: "image", video: "video", audio: "audio file" };

/** Media and PDFs rendered from the streaming route; they fill the pane. */
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
  readonly kind: FileMediaKind;
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
  else if (kind === "pdf")
    body = (
      <PdfView
        active={active}
        label={label}
        path={path}
        threadId={threadId}
        version={metadata.data.version}
      />
    );
  else if (failed)
    body = (
      <DownloadCard
        threadId={threadId}
        path={path}
        title={
          kind === "image"
            ? "This image cannot be displayed in the browser"
            : `This ${mediaNoun[kind]} cannot be played in the browser`
        }
        detail="Download it to open it on your device."
      />
    );
  else if (kind === "audio")
    body = (
      <div className="thread-file-media thread-file-media-audio">
        <figure>
          <AudioLines aria-hidden="true" />
          <figcaption title={path}>{path.split("/").at(-1)}</figcaption>
          {/* biome-ignore lint/a11y/useMediaCaption: sandbox audio has no caption track. */}
          <audio
            aria-label={label}
            controls
            onError={() => setFailed(true)}
            preload="metadata"
            src={sandboxFileUrl(threadId, path)}
          />
          <span>{formatBytes(metadata.data.sizeBytes)}</span>
        </figure>
      </div>
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
  const previewKind = filePreviewKind(path);
  const [mode, setMode] = React.useState<"preview" | "source" | null>(null);
  const references = { threadId, location: { kind: "sandbox" as const, path } };
  const content = preview.data?.kind === "text" ? preview.data.content : "";
  const file = { name: path, contents: content };
  // A highlighted range is only visible in source; show it there by default.
  const viewMode =
    mode ??
    (previewKind !== undefined && resolveReveal(content, reveal) === undefined
      ? "preview"
      : "source");
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
  else if (previewKind !== undefined && viewMode === "preview")
    body = (
      <FilePreview
        content={content}
        kind={previewKind}
        path={path}
        references={references}
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
      <Toolbar threadId={threadId} path={path} label={path}>
        {previewKind === undefined || preview.data?.kind !== "text" ? null : (
          <button
            type="button"
            className="thread-file-mode"
            aria-label={`${viewMode === "preview" ? "Preview" : "Source"}, switch to ${viewMode === "preview" ? "Source" : "Preview"}`}
            onClick={() =>
              setMode(viewMode === "preview" ? "source" : "preview")
            }
          >
            <span>{viewMode === "preview" ? "Preview" : "Source"}</span>
          </button>
        )}
      </Toolbar>
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
  onShowInFiles,
}: {
  readonly active: boolean;
  readonly file: CenterFileTab;
  readonly threadId: ThreadId;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onShowInFiles?: () => void;
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
      {...(onShowInFiles === undefined ? {} : { onShowInFiles })}
      {...(reveal === undefined ? {} : { reveal })}
      {...(sequence === undefined ? {} : { revealSequence: sequence })}
    />
  );
}
