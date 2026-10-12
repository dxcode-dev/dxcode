import {
  type ThreadAgentInitializationData,
  type ThreadDetailData,
  threadSettlementProvenance,
  withMessageAuthor,
} from "@dx/api";
import {
  type FailedSend,
  isInputTooLargeError,
  type UseFlueAgentResult,
} from "@flue/react";
import {
  AlertCircle,
  ArrowUp,
  RotateCcw,
  Settings2,
  Square,
  X,
} from "lucide-react";
import * as React from "react";
import { Badge } from "../../shared/ui/badge.js";
import { Button } from "../../shared/ui/button.js";
import { useDictation } from "./dictation/use-dictation.js";
import {
  captureScreenshot,
  createPendingAttachmentCollection,
  attachmentsUploading,
  disposeAttachments,
  messageWithAttachments,
  pastedFiles,
  type PendingAttachment,
  type PendingAttachmentCollection,
} from "./image-attachments.js";
import {
  AttachmentMenu,
  ImagePreviews,
  useAttachmentsUploading,
} from "./image-attachments-ui.js";
import { useImageDropTarget } from "./image-drop-target.js";
import { ProcessingIndicator } from "./processing-indicator.js";
import {
  type ComposerMentions,
  useComposerMentions,
} from "./sharing/chat-composer.js";
import { UserMessageText } from "./sharing/message-authors.js";
import { draftMode } from "./sharing/thread-chat.js";
import type {
  OptimisticThreadCreation,
  PendingSubmissionControl,
  PendingSubmissionImageRetention,
} from "./thread-session-registry.js";
import {
  INBOUND_MESSAGE_PREFIX,
  ThreadTranscript,
} from "./thread-transcript.js";
import { deriveTranscriptViewModel } from "./transcript-view-model.js";
import {
  type PresentationValue,
  usePresentationValue,
  useThreadPresentationValue,
} from "./use-thread-presentation.js";

/** The first message until Flue exposes it, rendered as Flue's row will be. */
function OptimisticInitialMessage({
  creation,
}: {
  readonly creation: OptimisticThreadCreation;
}) {
  return (
    <article
      className="transcript-row conversation-message user-message"
      data-optimistic-initial-message=""
    >
      <div className="message-content">
        {creation.body ? <UserMessageText text={creation.body} /> : null}
        <ImagePreviews images={creation.images} onRemove={() => {}} disabled />
      </div>
    </article>
  );
}

function AgentTranscriptHeader({
  agentInitialization,
  archived,
  historyReady,
  messageCount,
}: {
  readonly agentInitialization: ThreadAgentInitializationData;
  readonly archived: boolean;
  readonly historyReady: boolean;
  readonly messageCount: number;
}) {
  return (
    <>
      {agentInitialization.skills.length > 0 ? (
        <aside
          className="thread-skill-snapshot"
          aria-label="Resolved skill versions"
        >
          <strong>Resolved skills</strong>
          <div>
            {agentInitialization.skills.map((skill) => (
              <Badge key={`${skill.id}:${skill.version}`}>
                {skill.name} v{skill.version} · {skill.scope}
              </Badge>
            ))}
          </div>
        </aside>
      ) : null}
      {historyReady && messageCount === 0 ? (
        <div className="empty-conversation">
          <strong>
            {archived ? "Archived thread" : "What should we work on?"}
          </strong>
          <span>
            {archived
              ? "This thread has no messages."
              : "Send a message to start this thread."}
          </span>
        </div>
      ) : null}
    </>
  );
}

function AgentTranscriptFooter({
  statusMessage,
}: {
  readonly statusMessage?: string;
}) {
  return (
    <>
      {statusMessage === undefined ? null : (
        <ProcessingIndicator
          accessibleLabel={statusMessage}
          className="initial-thread-status"
          label={statusMessage}
        />
      )}
    </>
  );
}

type ThreadErrorPresentation = {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly action:
    | "none"
    | "refresh"
    | "resume"
    | "retry-send"
    | "model-routing";
  readonly failedSend?: FailedSend;
};

const errorSearchText = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null) return "";
  const record = error as Record<string, unknown>;
  return [record.type, record.message, record.details, record.meta]
    .map(errorSearchText)
    .filter(Boolean)
    .join(" ");
};

const modelRoutingErrorMessage = (error: unknown) => {
  const text = errorSearchText(error);
  const model = text.match(/MODEL_NOT_SERVED:\s*([\w./:-]+)/i)?.[1];
  if (model !== undefined) {
    return `Model ${model} is not currently served. Choose another model or update Model Routing.`;
  }
  if (text.toLowerCase().includes("no healthy deployments")) {
    return "No healthy deployment is available for this model. Choose another model or update Model Routing.";
  }
  return "No deployment is available for this model. Choose another model or update Model Routing.";
};

const isModelRoutingError = (error: unknown) => {
  const text = errorSearchText(error).toLowerCase();
  return (
    text.includes("model_not_served") ||
    text.includes("model not served") ||
    text.includes("no healthy deployments") ||
    text.includes("no deployments for this model") ||
    text.includes("available model group") ||
    text.includes("add or enable a connection")
  );
};

const threadErrorPresentation = (
  agent: UseFlueAgentResult,
  dismissed: ReadonlySet<string>,
): ThreadErrorPresentation | undefined => {
  const failedSend = agent.failedSends.findLast(
    ({ id }) => !dismissed.has(`send:${id}`),
  );
  if (failedSend !== undefined) {
    return {
      id: `send:${failedSend.id}`,
      title: "Message not sent",
      message: "Check your connection.",
      action: "retry-send",
      failedSend,
    };
  }

  if (agent.status === "submitted" || agent.status === "streaming") {
    return undefined;
  }

  const latestSettlement = agent.settlements.at(-1);
  const latestSettlementFailed = latestSettlement?.outcome === "failed";
  const latestSettlementInterrupted =
    latestSettlement?.outcome === "aborted" &&
    threadSettlementProvenance(latestSettlement.error) !== "user-stop";
  if (
    (latestSettlementFailed || latestSettlementInterrupted) &&
    !dismissed.has(`settlement:${latestSettlement.submissionId}`)
  ) {
    if (latestSettlementFailed && isModelRoutingError(latestSettlement.error)) {
      return {
        id: `settlement:${latestSettlement.submissionId}`,
        title: "Model unavailable",
        message: modelRoutingErrorMessage(latestSettlement.error),
        action: "model-routing",
      };
    }
    return {
      id: `settlement:${latestSettlement.submissionId}`,
      title: "Provider error",
      message: "The provider could not complete this request.",
      action: "resume",
    };
  }

  const latestSettlementMessage =
    latestSettlement === undefined
      ? agent.messages.findLast((message) => message.settlement !== undefined)
      : undefined;
  const failedSettlementMessage =
    latestSettlementMessage?.settlement?.outcome === "failed"
      ? latestSettlementMessage
      : undefined;
  if (failedSettlementMessage !== undefined) {
    const id = `settlement-message:${failedSettlementMessage.submissionId ?? failedSettlementMessage.id}`;
    if (!dismissed.has(id)) {
      return {
        id,
        title: "Provider error",
        message: "The provider could not complete this request.",
        action: "resume",
      };
    }
  }

  if (agent.error !== undefined) {
    const id = `agent:${agent.error.name}:${agent.error.message}`;
    if (dismissed.has(id)) return undefined;
    return {
      id,
      title: "Connection error",
      message: "The conversation could not refresh.",
      action: "refresh",
    };
  }
  return undefined;
};

function ThreadErrorCard({
  error,
  retrying,
  onDismiss,
  onOpenModelRouting,
  onRetry,
}: {
  readonly error: ThreadErrorPresentation;
  readonly retrying: boolean;
  readonly onDismiss: () => void;
  readonly onOpenModelRouting?: () => void;
  readonly onRetry?: () => void;
}) {
  const settingsAction =
    error.action === "model-routing" && onOpenModelRouting !== undefined;
  const retryAction = onRetry !== undefined;
  return (
    <div className="thread-error-row">
      <aside className="thread-error-card" role="alert">
        <AlertCircle aria-hidden="true" />
        <div className="thread-error-copy">
          <strong>{error.title}</strong>
          <span>{error.message}</span>
          {retryAction || settingsAction ? (
            <div className="thread-error-actions">
              {retryAction ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={retrying}
                  onClick={onRetry}
                >
                  <RotateCcw /> {retrying ? "Retrying…" : "Retry"}
                </Button>
              ) : null}
              {settingsAction ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={retrying}
                  onClick={() => onOpenModelRouting()}
                >
                  <Settings2 /> Open Model Routing
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="thread-error-dismiss"
          aria-label="Dismiss error"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </aside>
    </div>
  );
}

function AgentThreadErrorCard({
  agent,
  actionError,
  archived,
  onActionErrorChange,
  onOpenModelRouting,
}: {
  readonly agent: UseFlueAgentResult;
  readonly actionError?: ThreadErrorPresentation;
  readonly archived: boolean;
  readonly onActionErrorChange: (
    error: ThreadErrorPresentation | undefined,
  ) => void;
  readonly onOpenModelRouting?: () => void;
}) {
  const [dismissed, setDismissed] = React.useState(() => new Set<string>());
  const [retrying, setRetrying] = React.useState(false);
  const agentError = threadErrorPresentation(agent, dismissed);
  // A send that Flue retained as a failed send carries its own Retry. The
  // generic "Message not sent" from the rejected sendMessage would hide it,
  // so the retryable card wins. Oversized input has no failed send to retry
  // and keeps its specific message.
  const error =
    actionError?.id === "action:send" && agentError?.action === "retry-send"
      ? agentError
      : (actionError ?? agentError);
  if (error === undefined) return null;

  const dismiss = () => {
    if (error === actionError) onActionErrorChange(undefined);
    else {
      // The shadowed generic send error must not reappear once the failed
      // send is dismissed.
      if (actionError?.id === "action:send") onActionErrorChange(undefined);
      setDismissed((current) => new Set(current).add(error.id));
    }
  };
  const retry = async () => {
    onActionErrorChange(undefined);
    setRetrying(true);
    try {
      if (error.action === "retry-send" && error.failedSend !== undefined) {
        if (error.failedSend.retry === "resend") {
          await agent.resendPrompt(error.failedSend.id);
        } else {
          await agent.retrySend(error.failedSend.id);
        }
      } else if (error.action === "refresh") {
        agent.refresh();
        return;
      } else {
        await agent.resume();
      }
      setDismissed((current) => new Set(current).add(error.id));
    } catch {
      onActionErrorChange({
        id: "action:retry",
        title: "Retry failed",
        message: "Check your connection.",
        action: "none",
      });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <ThreadErrorCard
      error={error}
      retrying={retrying}
      onDismiss={dismiss}
      onOpenModelRouting={archived ? undefined : onOpenModelRouting}
      onRetry={
        archived || error.action === "none" ? undefined : () => void retry()
      }
    />
  );
}

const observeComposerDock = (node: HTMLDivElement) => {
  const pane = node.closest<HTMLElement>(".agent-pane");
  const composer = node.querySelector<HTMLElement>(".agent-composer");
  if (pane === null || composer === null) return;
  const updateHeight = () => {
    pane.style.setProperty(
      "--agent-composer-dock-height",
      `${node.offsetHeight}px`,
    );
    pane.style.setProperty(
      "--agent-composer-height",
      `${composer.offsetHeight}px`,
    );
  };
  updateHeight();
  const observer = new ResizeObserver(updateHeight);
  observer.observe(node);
  observer.observe(composer);
  return () => {
    observer.disconnect();
    pane.style.removeProperty("--agent-composer-dock-height");
    pane.style.removeProperty("--agent-composer-height");
  };
};

function AgentComposer({
  agentActive,
  stopAvailable,
  dictationAvailable,
  draftValue,
  draftLocked,
  images,
  errorCard,
  dockRef,
  mentions,
  onAbort,
  onAddImages,
  onRemoveImage,
  onSubmit,
  onTakeScreenshot,
  ref,
}: {
  readonly mentions?: ComposerMentions;
  readonly agentActive: boolean;
  readonly stopAvailable: boolean;
  readonly dictationAvailable: boolean;
  /** Only the composer subscribes, so typing never re-renders the transcript. */
  readonly draftValue: PresentationValue<string>;
  readonly draftLocked: boolean;
  readonly images: ReadonlyArray<PendingAttachment>;
  readonly errorCard?: React.ReactNode;
  readonly dockRef: React.RefCallback<HTMLDivElement>;
  readonly onAbort: () => void;
  readonly onAddImages: (files: ReadonlyArray<File>) => void;
  readonly onRemoveImage: (image: PendingAttachment) => void;
  readonly onSubmit: (draft: string) => void;
  readonly onTakeScreenshot: () => void;
  readonly ref: React.RefCallback<HTMLFormElement>;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const draft = usePresentationValue(draftValue);
  const onChangeDraft = draftValue.set;
  const dictation = useDictation({
    enabled: dictationAvailable,
    locked: draftLocked,
    onChange: onChangeDraft,
    onSend: onSubmit,
    textareaRef,
  });
  const uploading = useAttachmentsUploading(images);
  const dropTarget = useImageDropTarget({
    disabled: draftLocked || uploading,
    onFiles: onAddImages,
  });
  const composerMentions = useComposerMentions({
    mentions,
    draft,
    setDraft: onChangeDraft,
    textareaRef,
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!dictation.interceptSubmit()) onSubmit(draft);
  };
  return (
    <div className="agent-composer-dock" ref={dockRef}>
      {errorCard}
      {composerMentions.popover}
      {composerMentions.banner}
      <form
        className="agent-composer"
        data-chat-mode={composerMentions.chatMode ? "" : undefined}
        onSubmit={submit}
        ref={ref}
        {...dropTarget}
      >
        <textarea
          ref={textareaRef}
          aria-label="Message"
          data-command-target="thread-composer"
          disabled={draftLocked}
          placeholder="Message"
          value={draft}
          {...composerMentions.textareaProps}
          onChange={(event) => {
            onChangeDraft(event.target.value);
            composerMentions.onInput(event);
          }}
          onSelect={composerMentions.trackCaret}
          onPaste={(event) => {
            const files = pastedFiles(event);
            if (files.length === 0 || draftLocked || uploading) return;
            event.preventDefault();
            onAddImages(files);
          }}
          onKeyDown={(event) => {
            if (composerMentions.onKeyDown(event)) {
              event.preventDefault();
              return;
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-actions">
          <AttachmentMenu
            disabled={draftLocked || uploading}
            onFiles={onAddImages}
            onScreenshot={onTakeScreenshot}
          />
          <ImagePreviews
            images={images}
            onRemove={onRemoveImage}
            disabled={draftLocked}
          />
          <span className="composer-spacer" />
          {dictation.controls}
          {dictation.hideSubmit ? null : (
            <Button
              type="submit"
              size="icon-sm"
              className="composer-submit"
              aria-label={
                agentActive ? "Send steering message" : "Send message"
              }
              disabled={
                draftLocked ||
                uploading ||
                (!dictation.active && !draft.trim() && images.length === 0)
              }
            >
              <ArrowUp />
            </Button>
          )}
          {stopAvailable ? (
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              className="composer-submit"
              aria-label="Stop agent"
              onClick={onAbort}
            >
              <Square />
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

/** A shared Thread's owner ended multiplayer or revoked Contribute. */
const isReadOnlyRejection = (cause: unknown) =>
  cause instanceof Error &&
  "status" in cause &&
  cause.status === 403 &&
  "body" in cause &&
  typeof cause.body === "object" &&
  cause.body !== null &&
  "data" in cause.body &&
  typeof cause.body.data === "object" &&
  cause.body.data !== null &&
  "code" in cause.body.data &&
  cause.body.data.code === "THREAD_READ_ONLY";

/**
 * Core refused the message itself, for example an attachment that is no
 * longer available: its reason, so the person can fix the message.
 */
const admissionRejection = (cause: unknown) => {
  if (
    !(cause instanceof Error) ||
    !("status" in cause) ||
    cause.status !== 400 ||
    !("body" in cause) ||
    typeof cause.body !== "object" ||
    cause.body === null ||
    !("data" in cause.body) ||
    typeof cause.body.data !== "object" ||
    cause.body.data === null ||
    !("code" in cause.body.data) ||
    cause.body.data.code !== "INVALID_REQUEST" ||
    !("message" in cause.body.data) ||
    typeof cause.body.data.message !== "string"
  )
    return undefined;
  return cause.body.data.message;
};

function useAgentSubmission({
  agent,
  mentions,
  setDraft,
  images,
  setImages,
  imageCollection,
  submissionImageRetention,
  submissionPending,
  submissionControl,
  onSubmissionPendingChange,
  onAccessChanged,
}: {
  readonly onAccessChanged?: () => void;
  readonly agent: UseFlueAgentResult;
  readonly mentions?: ComposerMentions;
  readonly setDraft: (draft: string) => void;
  readonly images: ReadonlyArray<PendingAttachment>;
  readonly setImages: (images: ReadonlyArray<PendingAttachment>) => void;
  readonly imageCollection: PendingAttachmentCollection;
  readonly submissionImageRetention?: PendingSubmissionImageRetention;
  readonly submissionPending: boolean;
  readonly submissionControl: PendingSubmissionControl;
  readonly onSubmissionPendingChange?: (pending: boolean) => void;
}) {
  const [admissionPending, setAdmissionPending] = React.useState(false);
  // A chat message being admitted has no run to stop.
  const [admittingChat, setAdmittingChat] = React.useState(false);
  const submitInFlight = React.useRef(false);
  const submitGeneration = React.useRef(0);
  const composerMounted = React.useRef(false);
  const [actionError, setActionError] =
    React.useState<ThreadErrorPresentation>();
  const finishAdmission = () => {
    submitInFlight.current = false;
    submissionControl.stopRequested = false;
    onSubmissionPendingChange?.(false);
    setAdmissionPending(false);
  };
  const stopAgent = async () => {
    try {
      await agent.abort();
    } catch {
      setActionError({
        id: "action:stop",
        title: "Could not stop",
        message: "Check your connection.",
        action: "none",
      });
    }
  };
  const stop = async () => {
    submitGeneration.current += 1;
    if (submitInFlight.current || submissionPending)
      submissionControl.stopRequested = true;
    await stopAgent();
  };
  const submit = async (submittedDraft: string) => {
    const message = submittedDraft.trim();
    if (
      submitInFlight.current ||
      submissionPending ||
      (!message && images.length === 0) ||
      attachmentsUploading(images)
    )
      return;
    const failedUpload = images.find(
      ({ upload }) => upload.getSnapshot().status === "failed",
    );
    if (failedUpload !== undefined) {
      setActionError({
        id: "action:send",
        title: "Message not sent",
        message: `${failedUpload.filename} did not upload. Remove it and attach it again.`,
        action: "none",
      });
      return;
    }
    const mode =
      mentions?.mode === "members"
        ? draftMode(
            message,
            mentions.members,
            mentions.viewerId,
            mentions.conversationMode,
          )
        : "agent";
    if (mode === "chat" && images.length > 0) {
      setActionError({
        id: "action:send",
        title: "Message not sent",
        message:
          "Chat messages can't include attachments. Tag @dx to send them.",
        action: "none",
      });
      return;
    }
    submitInFlight.current = true;
    submissionControl.stopRequested = false;
    onSubmissionPendingChange?.(true);
    const generation = ++submitGeneration.current;
    setAdmittingChat(mode === "chat");
    setAdmissionPending(true);
    const runAdmission = async () => {
      let submittedImages: ReadonlyArray<PendingAttachment> | undefined;
      let imagesRetained = false;
      try {
        await imageCollection.settle();
        if (generation !== submitGeneration.current) return;
        submittedImages = imageCollection.take();
        imagesRetained =
          submissionImageRetention?.retain(submittedImages) ?? false;
        setDraft("");
        setImages([]);
        setActionError(undefined);
        await agent.sendMessage(
          await messageWithAttachments(message, submittedImages),
        );
        if (mentions?.mode === "members") mentions.onSent(mode);
        if (submissionControl.stopRequested) await stopAgent();
        if (
          !imagesRetained ||
          submissionImageRetention?.complete(submittedImages)
        )
          disposeAttachments(submittedImages);
      } catch (cause) {
        const rejection = admissionRejection(cause);
        if (
          submittedImages !== undefined &&
          (isInputTooLargeError(cause) || rejection !== undefined) &&
          composerMounted.current
        ) {
          if (imagesRetained)
            submissionImageRetention?.complete(submittedImages);
          setDraft(message);
          setImages(imageCollection.restore(submittedImages));
        } else if (submittedImages !== undefined) {
          if (imagesRetained)
            submissionImageRetention?.complete(submittedImages);
          disposeAttachments(submittedImages);
        }
        if (isReadOnlyRejection(cause)) {
          // Refresh access so the composer gives way to the viewer notice.
          onAccessChanged?.();
          if (!composerMounted.current) return;
          setDraft(message);
          setActionError({
            id: "action:send",
            title: "Message not sent",
            message: "Multiplayer ended. You can still view this thread.",
            action: "none",
          });
          return;
        }
        if (!composerMounted.current) return;
        // Refused messages keep their text so the person can correct them.
        if (rejection !== undefined && submittedImages === undefined)
          setDraft(message);
        setActionError({
          id: "action:send",
          title: "Message not sent",
          message:
            rejection ??
            (isInputTooLargeError(cause)
              ? "The message or attachments are too large."
              : "Check your connection."),
          action: "none",
        });
      }
    };
    return runAdmission().finally(finishAdmission);
  };
  return {
    actionError,
    composerMounted,
    admissionPending,
    admittingChat,
    setActionError,
    stop,
    submit,
  };
}

interface AgentPanelProps {
  /** What `@` does in the composer; absent for people who cannot send. */
  readonly mentions?: ComposerMentions;
  /** A send found the user's access changed; refresh the Thread. */
  readonly onAccessChanged?: () => void;
  /** Replaces the composer for people who can only view this Thread. */
  readonly readOnlyNotice?: React.ReactNode;
  readonly agent: UseFlueAgentResult & {
    readonly hasMore?: boolean;
    readonly loadingOlder?: boolean;
    readonly olderError?: Error;
    readonly loadOlder?: () => Promise<void>;
  };
  readonly agentInitialization: ThreadAgentInitializationData;
  readonly archived?: boolean;
  readonly showArchivedNotice?: boolean;
  readonly active?: boolean;
  readonly additionalPanels?: React.ReactNode;
  readonly renderHeader?: (
    model: ReturnType<typeof deriveTranscriptViewModel>,
  ) => React.ReactNode;
  /** The owner's draft; defaults to this Thread's retained composer draft. */
  readonly draft?: PresentationValue<string>;
  readonly images?: ReadonlyArray<PendingAttachment>;
  readonly onImagesChange?: (images: ReadonlyArray<PendingAttachment>) => void;
  readonly imageCollection?: PendingAttachmentCollection;
  readonly submissionImageRetention?: PendingSubmissionImageRetention;
  readonly submissionPending?: boolean;
  readonly submissionControl?: PendingSubmissionControl;
  readonly onSubmissionPendingChange?: (pending: boolean) => void;
  readonly dictationAvailable?: boolean;
  readonly workspaceReady?: boolean;
  readonly workspaceStatus?: string;
  readonly optimisticCreation?: OptimisticThreadCreation;
  readonly onInitialSubmissionObserved?: (submissionId: string) => void;
  readonly onOpenModelRouting?: () => void;
  /** Messages other Threads sent while this one worked, not yet joined. */
  readonly inboundMessages?: ThreadDetailData["inboundMessages"];
}

/** Pending composer images, owned here unless the caller retains them. */
function usePendingImages(
  controlledImages: ReadonlyArray<PendingAttachment> | undefined,
  onImagesChange:
    | ((images: ReadonlyArray<PendingAttachment>) => void)
    | undefined,
  retainedImageCollection: PendingAttachmentCollection | undefined,
) {
  const [localImages, setLocalImages] = React.useState<
    ReadonlyArray<PendingAttachment>
  >([]);
  const [imageCollection] = React.useState(
    () => retainedImageCollection ?? createPendingAttachmentCollection(),
  );
  return {
    images: controlledImages ?? localImages,
    setImages: onImagesChange ?? setLocalImages,
    imageCollection,
  };
}

function useImageActions(
  imageCollection: PendingAttachmentCollection,
  setImages: (images: ReadonlyArray<PendingAttachment>) => void,
  setActionError: ReturnType<typeof useAgentSubmission>["setActionError"],
) {
  const addImages = async (files: ReadonlyArray<File>) => {
    if (files.length === 0) return;
    setActionError(undefined);
    try {
      setImages(await imageCollection.addFiles(files));
    } catch (cause) {
      setActionError({
        id: "action:attach-image",
        title: "File not attached",
        message: cause instanceof Error ? cause.message : "Try another file.",
        action: "none",
      });
    }
  };

  const takeScreenshot = async () => {
    setActionError(undefined);
    try {
      setImages(await imageCollection.addGenerated(captureScreenshot));
    } catch (cause) {
      setActionError({
        id: "action:screenshot",
        title: "Screenshot not captured",
        message:
          cause instanceof Error
            ? cause.message
            : "The screenshot could not be captured.",
        action: "none",
      });
    }
  };
  return { addImages, takeScreenshot };
}

/**
 * A message another Thread sent while this one worked reaches Flue's history
 * only when it joins the turn. Until then a row shows that one is on its way
 * from its source Thread, after the history; its text arrives with Flue.
 */
/** Stands in for a pending message's text, which only Flue holds. */
const PENDING_INBOUND_TEXT = "…";

const withInboundMessages = (
  messages: AgentPanelProps["agent"]["messages"],
  inbound: AgentPanelProps["inboundMessages"],
  olderHistory: boolean,
): AgentPanelProps["agent"]["messages"] => {
  if (inbound === undefined || inbound.length === 0) return messages;
  const joined = new Set(
    messages.flatMap(({ submissionId }) =>
      submissionId === undefined ? [] : [submissionId],
    ),
  );
  // Flue joins waiting messages in order. One older than the oldest loaded
  // prompt has joined already, into history not loaded yet.
  const oldestLoadedPrompt = olderHistory
    ? Math.min(
        ...messages.flatMap((message) => {
          const at = Date.parse(
            String(message.timestamp ?? message.metadata?.timestamp ?? ""),
          );
          return message.role === "user" &&
            message.submissionId !== undefined &&
            !Number.isNaN(at)
            ? [at]
            : [];
        }),
      )
    : Number.NEGATIVE_INFINITY;
  const pending = inbound.filter(
    ({ submissionId, createdAt }) =>
      !joined.has(submissionId) && Date.parse(createdAt) >= oldestLoadedPrompt,
  );
  if (pending.length === 0) return messages;
  return [
    ...messages,
    ...pending.map(
      ({ submissionId, sourceThreadId }) =>
        ({
          id: `${INBOUND_MESSAGE_PREFIX}${submissionId}`,
          role: "user",
          purpose: "user",
          display: "visible",
          parts: [
            {
              type: "text",
              text: withMessageAuthor(
                {
                  author: { role: "owner", userId: "thread", name: "Thread" },
                  sourceThreadId,
                },
                PENDING_INBOUND_TEXT,
              ),
              state: "done",
            },
          ],
        }) as AgentPanelProps["agent"]["messages"][number],
    ),
  ];
};

/** The transcript model and run state the panel derives from Flue. */
function useAgentRunState({
  agent,
  inboundMessages,
  mentions,
  admissionPending,
  admittingChat,
  submissionPending,
  workspaceReady,
  workspaceStatus,
}: {
  readonly agent: AgentPanelProps["agent"];
  readonly inboundMessages: AgentPanelProps["inboundMessages"];
  readonly mentions: ComposerMentions | undefined;
  readonly admissionPending: boolean;
  readonly admittingChat: boolean;
  readonly submissionPending: boolean;
  readonly workspaceReady: boolean;
  readonly workspaceStatus: string | undefined;
}) {
  // A message being sent as chat starts no run; recognize its local echo.
  const chatEcho = React.useMemo(
    () =>
      mentions?.mode === "members"
        ? (text: string) =>
            draftMode(
              text,
              mentions.members,
              mentions.viewerId,
              mentions.conversationMode,
            ) === "chat"
        : undefined,
    [mentions],
  );
  // Derive only when Flue history changes, not on composer or layout state.
  const { messages, settlements, finalOutputs } = agent;
  const model = React.useMemo(
    () =>
      deriveTranscriptViewModel({
        // After history loads: a pending message ahead of it would move
        // once history arrives.
        messages: agent.historyReady
          ? withInboundMessages(
              messages,
              inboundMessages,
              agent.hasMore === true,
            )
          : messages,
        settlements,
        finalOutputs,
        chatEcho,
      }),
    [
      messages,
      agent.historyReady,
      agent.hasMore,
      inboundMessages,
      settlements,
      finalOutputs,
      chatEcho,
    ],
  );
  // Only chat is on its way and nothing runs: the agent is not working.
  const sendingOnlyChat =
    agent.status === "submitted" &&
    model.rows.some((row) => row.kind === "user-prompt" && !row.admitted) &&
    model.rows.every(
      (row) => row.kind !== "user-prompt" || row.admitted || row.chat === true,
    ) &&
    !model.turns.some((turn) => turn.status === "active");
  const agentActive =
    (agent.status === "submitted" && !sendingOnlyChat) ||
    agent.status === "streaming";
  const draftLocked = admissionPending || submissionPending;
  const stopAvailable = agentActive || (admissionPending && !admittingChat);
  const statusMessage =
    workspaceStatus ??
    (agent.status === "submitted" && !sendingOnlyChat && !workspaceReady
      ? "Preparing workspace…"
      : undefined);
  return { model, agentActive, draftLocked, stopAvailable, statusMessage };
}

export function AgentPanel({
  agent,
  agentInitialization,
  archived = false,
  showArchivedNotice = false,
  active = true,
  additionalPanels,
  renderHeader,
  draft: ownerDraft,
  images: controlledImages,
  onImagesChange,
  imageCollection: retainedImageCollection,
  submissionImageRetention,
  submissionPending = false,
  submissionControl: retainedSubmissionControl,
  onSubmissionPendingChange,
  dictationAvailable = false,
  workspaceReady = false,
  workspaceStatus,
  optimisticCreation,
  onInitialSubmissionObserved,
  onOpenModelRouting,
  inboundMessages,
  readOnlyNotice,
  onAccessChanged,
  mentions,
}: AgentPanelProps) {
  const retainedDraft = useThreadPresentationValue("draft", "");
  const draftValue = ownerDraft ?? retainedDraft;
  const { images, setImages, imageCollection } = usePendingImages(
    controlledImages,
    onImagesChange,
    retainedImageCollection,
  );
  const [localSubmissionControl] = React.useState<PendingSubmissionControl>(
    () => ({
      stopRequested: false,
    }),
  );
  const submissionControl = retainedSubmissionControl ?? localSubmissionControl;
  const {
    actionError,
    composerMounted,
    admissionPending,
    admittingChat,
    setActionError,
    stop,
    submit,
  } = useAgentSubmission({
    agent,
    mentions,
    setDraft: draftValue.set,
    images,
    setImages,
    imageCollection,
    submissionImageRetention,
    submissionPending,
    submissionControl,
    onSubmissionPendingChange,
    onAccessChanged,
  });
  const { model, agentActive, draftLocked, stopAvailable, statusMessage } =
    useAgentRunState({
      agent,
      inboundMessages,
      mentions,
      admissionPending,
      admittingChat,
      submissionPending,
      workspaceReady,
      workspaceStatus,
    });
  const initialSubmissionObserved =
    optimisticCreation?.submissionId !== undefined &&
    agent.messages.some(
      (message) =>
        message.role === "user" &&
        message.submissionId === optimisticCreation.submissionId,
    );
  const reconcileInitialSubmission = React.useCallback(
    (node: HTMLSpanElement | null) => {
      if (
        node === null ||
        optimisticCreation?.submissionId === undefined ||
        onInitialSubmissionObserved === undefined
      )
        return;
      const submissionId = optimisticCreation.submissionId;
      queueMicrotask(() => onInitialSubmissionObserved(submissionId));
    },
    [onInitialSubmissionObserved, optimisticCreation?.submissionId],
  );

  const { addImages, takeScreenshot } = useImageActions(
    imageCollection,
    setImages,
    setActionError,
  );

  const composerDockRef = React.useCallback(
    (node: HTMLDivElement | null) =>
      node === null ? undefined : observeComposerDock(node),
    [],
  );

  const composerLifetimeRef = React.useCallback(
    (node: HTMLFormElement | null) => {
      if (node === null) return;
      composerMounted.current = true;
      return () => {
        composerMounted.current = false;
        if (retainedImageCollection === undefined)
          void imageCollection.settle().then(() => imageCollection.dispose());
      };
    },
    [composerMounted, imageCollection, retainedImageCollection],
  );
  const errorCard = (
    <AgentThreadErrorCard
      agent={agent}
      actionError={actionError}
      archived={archived}
      onActionErrorChange={setActionError}
      onOpenModelRouting={onOpenModelRouting}
    />
  );

  return (
    <div
      className="agent-panel-stack"
      data-archived={archived ? "" : undefined}
    >
      {renderHeader?.(model)}
      {showArchivedNotice ? (
        <div className="archived-thread-warning" role="note">
          Archived. Unarchive to resume or run commands.
        </div>
      ) : null}
      <section
        className="workspace-pane agent-pane"
        aria-label="Agent chat"
        hidden={!active}
      >
        <ThreadTranscript
          model={model}
          active={active}
          historyReady={agent.historyReady}
          hasMore={agent.hasMore}
          loadingOlder={agent.loadingOlder}
          olderError={agent.olderError}
          loadOlder={agent.loadOlder}
          showProcessingIndicator={!archived && statusMessage === undefined}
          header={
            <AgentTranscriptHeader
              agentInitialization={agentInitialization}
              archived={archived}
              historyReady={agent.historyReady}
              messageCount={
                agent.messages.length +
                (optimisticCreation !== undefined && !initialSubmissionObserved
                  ? 1
                  : 0)
              }
            />
          }
          pinnedContent={
            optimisticCreation ===
            undefined ? null : initialSubmissionObserved ? (
              <span hidden ref={reconcileInitialSubmission} />
            ) : (
              <OptimisticInitialMessage creation={optimisticCreation} />
            )
          }
          footer={
            archived ? (
              errorCard
            ) : (
              <AgentTranscriptFooter statusMessage={statusMessage} />
            )
          }
        />

        {archived ? null : readOnlyNotice !== undefined ? (
          <div className="agent-composer-dock" ref={composerDockRef}>
            {readOnlyNotice}
          </div>
        ) : (
          <AgentComposer
            agentActive={agentActive}
            stopAvailable={stopAvailable}
            dictationAvailable={dictationAvailable}
            draftValue={draftValue}
            draftLocked={draftLocked}
            images={images}
            dockRef={composerDockRef}
            errorCard={errorCard}
            mentions={mentions}
            onAbort={() => void stop()}
            onAddImages={(files) => void addImages(files)}
            onRemoveImage={(image) => {
              setImages(imageCollection.remove(image.id));
            }}
            onSubmit={(submittedDraft) => void submit(submittedDraft)}
            onTakeScreenshot={() => void takeScreenshot()}
            ref={composerLifetimeRef}
          />
        )}
      </section>
      {additionalPanels}
    </div>
  );
}
