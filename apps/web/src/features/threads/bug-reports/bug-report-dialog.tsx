import type {
  BugReportChangesDiagnostics,
  BugReportDictationDiagnostics,
  BugReportThreadAndAppDiagnostics,
  ProjectData,
  ThreadDetailData,
} from "@dx/api";
import { BUG_REPORT_IMAGE_MAX_BYTES, BUG_REPORT_MAX_IMAGES } from "@dx/api";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImagePlus, LoaderCircle, X } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { getBrowserCommandRegistry } from "../../../shared/commands/command-registry.js";
import { ShortcutKeycaps } from "../../../shared/commands/shortcut-keycaps.js";
import { clientDiagnostics } from "../../../shared/diagnostics/client-diagnostics.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { loadedChanges } from "../changes/changes-queries.js";
import type { DictationRecord } from "../dictation/dictation-session.js";
import { serializeThreadJson } from "../thread-export.js";
import type { TranscriptViewModel } from "../transcript-view-model.js";
import { sendBugReportMutationOptions } from "./bug-report-queries.js";
import { ReportStatus } from "./bug-report-status.js";
import "./bug-reports.css";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Room under Core's 4 MB limit for the rest of the diagnostics. */
const TRANSCRIPT_MAX_CHARACTERS = 3_000_000;

interface PendingImage {
  readonly id: string;
  readonly file: File;
  readonly url: string;
}

/** The transcript as its JSON export writes it, its oldest turns cut to fit. */
const transcriptExport = (input: Parameters<typeof serializeThreadJson>[0]) => {
  const exported = JSON.parse(serializeThreadJson(input)) as {
    turns: unknown[];
    omittedTurns?: number;
  };
  let omitted = 0;
  while (
    exported.turns.length > 0 &&
    JSON.stringify(exported).length > TRANSCRIPT_MAX_CHARACTERS
  ) {
    exported.turns.shift();
    omitted += 1;
  }
  return omitted === 0 ? exported : { ...exported, omittedTurns: omitted };
};

const collectThreadAndApp = (
  thread: ThreadDetailData,
  project: Pick<ProjectData, "name"> | undefined,
  transcript: () => TranscriptViewModel,
): BugReportThreadAndAppDiagnostics => ({
  app: {
    path: window.location.pathname,
    userAgent: navigator.userAgent.slice(0, 1_024),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    online: navigator.onLine,
    visibility: document.visibilityState,
  },
  ...clientDiagnostics(),
  transcript: transcriptExport({ thread, project, model: transcript() }),
});

/** Room under Core's 4 MB limit after Thread and App Diagnostics. */
const CHANGES_MAX_CHARACTERS = 600_000;

/**
 * Diff Diagnostics: the open Changes pane's view, from the attributes it
 * renders, and the Changes queries it loaded, the largest cut to fit.
 */
const collectChanges = (
  queryClient: QueryClient,
  threadId: ThreadDetailData["id"],
): BugReportChangesDiagnostics => {
  const pane = document.querySelector<HTMLElement>(
    `.changes-pane[data-thread-id="${threadId}"]`,
  );
  const { loaded, truncated } = loadedChanges(
    queryClient,
    threadId,
    CHANGES_MAX_CHARACTERS,
  );
  const expanded = (pane?.dataset.expanded ?? "")
    .split("\n")
    .filter((entry) => entry !== "")
    .slice(0, 500);
  return {
    view: {
      range: (pane?.dataset.range ?? "").slice(0, 256),
      diffStyle: pane?.dataset.diffStyle ?? "",
      overflow: pane?.dataset.overflow ?? "",
      sortByName: pane?.dataset.sort === "name",
      expanded,
    },
    loaded,
    truncated,
  };
};

const dictationDetails = (
  dictation: DictationRecord,
): BugReportDictationDiagnostics => ({
  ...(dictation.transcript === undefined
    ? {}
    : { transcript: dictation.transcript.slice(0, 50_000) }),
  outcome: dictation.outcome,
  ...(dictation.error === undefined
    ? {}
    : { error: dictation.error.slice(0, 1_000) }),
  mode: dictation.mode,
  jobId: dictation.jobId,
  startedAt: dictation.startedAt,
  finishedAt: dictation.finishedAt,
  audioBytes: dictation.audio.size,
  audioType: dictation.audio.type || "audio/wav",
});

const SENT_TEXT = {
  saved: "This dx deployment keeps reports without filing them on GitHub.",
  failed: "It was saved, but it could not be filed on GitHub.",
  filing: "It is being filed. Your Reports shows the issue once it is.",
  commented: "It matches an open issue, so it was added there.",
  filed: "It was filed as a new issue.",
} as const;

/** Your Reports, as a link that closes the dialog by leaving the Thread. */
function YourReportsLink() {
  return (
    <Link className="bug-report-reports-link" to="/bug-reports">
      Your Reports
    </Link>
  );
}

/**
 * Report Bug: the person describes the problem, attaches images, and chooses
 * the diagnostics sent with it. Core redacts secrets, then files the report
 * as a GitHub issue or comments on an open issue it duplicates.
 */
export function BugReportDialog({
  thread,
  project,
  transcript,
  changesOpen,
  dictation,
  onClose,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly transcript: () => TranscriptViewModel;
  /** The Changes pane was open as the dialog opened. */
  readonly changesOpen: boolean;
  /** The Thread's latest dictation, kept on this device. */
  readonly dictation?: DictationRecord;
  readonly onClose: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const send = useMutation(
    sendBugReportMutationOptions(queryClient, identity.id),
  );
  const [message, setMessage] = React.useState("");
  const [images, setImages] = React.useState<ReadonlyArray<PendingImage>>([]);
  const [imageError, setImageError] = React.useState<string>();
  const [threadAndApp, setThreadAndApp] = React.useState(true);
  const [diff, setDiff] = React.useState(false);
  const [dictated, setDictated] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const sendKeycaps =
    getBrowserCommandRegistry().getDisplayedKeycaps("Mod+Enter");

  const close = () => {
    for (const image of images) URL.revokeObjectURL(image.url);
    onClose();
  };
  const addImages = (files: ReadonlyArray<File>) => {
    const accepted: PendingImage[] = [];
    let error: string | undefined;
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        error = "Attach PNG, JPEG, GIF, or WebP images.";
        continue;
      }
      if (file.size > BUG_REPORT_IMAGE_MAX_BYTES) {
        error = "Each image must be 10 MB or smaller.";
        continue;
      }
      if (images.length + accepted.length >= BUG_REPORT_MAX_IMAGES) {
        error = `Attach up to ${BUG_REPORT_MAX_IMAGES} images.`;
        break;
      }
      accepted.push({
        id: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
      });
    }
    setImageError(error);
    if (accepted.length > 0) setImages([...images, ...accepted]);
  };
  const removeImage = (id: string) => {
    const image = images.find((candidate) => candidate.id === id);
    if (image !== undefined) URL.revokeObjectURL(image.url);
    setImages(images.filter((candidate) => candidate.id !== id));
    setImageError(undefined);
  };
  const canSend = message.trim() !== "" && !send.isPending;
  const submit = () => {
    if (!canSend) return;
    send.mutate({
      threadId: thread.id,
      report: {
        message: message.trim(),
        diagnostics: {
          ...(threadAndApp
            ? {
                threadAndApp: collectThreadAndApp(thread, project, transcript),
              }
            : {}),
          ...(diff && changesOpen
            ? { changes: collectChanges(queryClient, thread.id) }
            : {}),
          ...(dictated && dictation !== undefined
            ? { dictation: dictationDetails(dictation) }
            : {}),
        },
      },
      images: images.map(({ file }) => file),
      ...(dictated && dictation !== undefined
        ? { audio: dictation.audio }
        : {}),
    });
  };

  const sent = send.data;
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open && !send.isPending) close();
      }}
    >
      <DialogContent className="bug-report-dialog">
        {sent !== undefined ? (
          <div className="bug-report-sent">
            <DialogTitle>Bug Report Sent</DialogTitle>
            <DialogDescription>{SENT_TEXT[sent.status]}</DialogDescription>
            <ReportStatus report={sent} />
            <footer className="bug-report-footer">
              <YourReportsLink />
              <Button size="sm" onClick={close}>
                Done
              </Button>
            </footer>
          </div>
        ) : (
          <form
            className="bug-report-form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files"))
                event.preventDefault();
            }}
            onDrop={(event) => {
              if (event.dataTransfer.files.length === 0) return;
              event.preventDefault();
              addImages([...event.dataTransfer.files]);
            }}
          >
            <DialogTitle>Report Bug</DialogTitle>
            <div className="bug-report-message">
              <textarea
                aria-label="Bug description"
                placeholder="Describe the problem, what you expected, and steps to reproduce it."
                value={message}
                disabled={send.isPending}
                onChange={(event) => setMessage(event.currentTarget.value)}
                onPaste={(event) => {
                  const files = [...event.clipboardData.files];
                  if (files.length === 0) return;
                  event.preventDefault();
                  addImages(files);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              {images.length === 0 ? null : (
                <ul className="bug-report-images" aria-label="Attached images">
                  {images.map((image) => (
                    <li key={image.id}>
                      <img src={image.url} alt={image.file.name} />
                      <button
                        type="button"
                        aria-label={`Remove ${image.file.name}`}
                        disabled={send.isPending}
                        onClick={() => removeImage(image.id)}
                      >
                        <X />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="bug-report-message-tools">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Attach images"
                  title="Attach images"
                  disabled={
                    send.isPending || images.length >= BUG_REPORT_MAX_IMAGES
                  }
                  onClick={() => fileInput.current?.click()}
                >
                  <ImagePlus />
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={IMAGE_TYPES.join(",")}
                  multiple
                  hidden
                  onChange={(event) => {
                    addImages([...(event.currentTarget.files ?? [])]);
                    event.currentTarget.value = "";
                  }}
                />
                {imageError === undefined ? null : (
                  <span className="bug-report-error" role="alert">
                    {imageError}
                  </span>
                )}
              </div>
            </div>
            <section
              className="bug-report-diagnostics"
              aria-labelledby="bug-report-diagnostics-title"
            >
              <h3 id="bug-report-diagnostics-title">Diagnostic Data</h3>
              <label className="bug-report-option">
                <input
                  type="checkbox"
                  checked={threadAndApp}
                  disabled={send.isPending}
                  onChange={(event) =>
                    setThreadAndApp(event.currentTarget.checked)
                  }
                />
                <span className="bug-report-option-title">
                  Thread and App Diagnostics
                </span>
                <span className="bug-report-option-detail">
                  This Thread's transcript, recent app errors and failed
                  requests, connection state, its Worker logs, the Orb and agent
                  state dx holds, and the Orb's setup scripts. Secrets are
                  redacted.
                </span>
              </label>
              <label
                className="bug-report-option"
                data-disabled={changesOpen ? undefined : ""}
              >
                <input
                  type="checkbox"
                  checked={diff && changesOpen}
                  disabled={send.isPending || !changesOpen}
                  onChange={(event) => setDiff(event.currentTarget.checked)}
                />
                <span className="bug-report-option-title">
                  Diff Diagnostics
                </span>
                <span className="bug-report-option-detail">
                  The changes and diffs Changes has loaded, with how it shows
                  them. Secrets are redacted.
                  {changesOpen
                    ? null
                    : " Open Changes to include diff diagnostics."}
                </span>
              </label>
              <label
                className="bug-report-option"
                data-disabled={dictation === undefined ? "" : undefined}
              >
                <input
                  type="checkbox"
                  checked={dictated && dictation !== undefined}
                  disabled={send.isPending || dictation === undefined}
                  onChange={(event) => setDictated(event.currentTarget.checked)}
                />
                <span className="bug-report-option-title">
                  Dictation Diagnostics
                </span>
                <span className="bug-report-option-detail">
                  The latest dictation's original audio, transcript, and
                  transcription details. Audio stays on this device unless you
                  select this option and send the report.
                  {dictation === undefined
                    ? " Dictate in this Thread to include it."
                    : null}
                </span>
              </label>
            </section>
            {send.isError ? (
              <p className="bug-report-error" role="alert">
                {send.error instanceof Error
                  ? send.error.message
                  : "The bug report could not be sent."}
              </p>
            ) : null}
            <footer className="bug-report-footer">
              <YourReportsLink />
              <Button type="submit" size="sm" disabled={!canSend}>
                {send.isPending ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : null}
                Send Bug Report
                <ShortcutKeycaps keycaps={sendKeycaps} emptyLabel="" />
              </Button>
            </footer>
          </form>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
