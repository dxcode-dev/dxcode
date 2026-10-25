import {
  type ThreadAgentInitializationData,
  type ThreadDetailData,
  threadSettlementProvenance,
  withMessageAuthor,
} from "@dx/api";
import {
  type ClaudePlanLimit,
  claudePlanWindowName,
  parseClaudePlanLimit,
} from "@dx/domain";
import type { FailedSend, UseFlueAgentResult } from "@flue/react";
import {
  AlertCircle,
  ArrowUp,
  ExternalLink,
  RotateCcw,
  Settings2,
  Square,
  X,
} from "lucide-react";
import * as React from "react";
import { settle } from "../../shared/settle.js";
import { Badge } from "../../shared/ui/badge.js";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { useComposerEnterKey } from "./composer-enter-key.js";
import { useDictation } from "./dictation/use-dictation.js";
import {
  addScreenshot,
  attachmentsUploading,
  createPendingAttachmentCollection,
  disposeAttachments,
  messageWithAttachments,
  type PendingAttachment,
  type PendingAttachmentCollection,
  pastedFiles,
} from "./image-attachments.js";
import {
  AttachmentMenu,
  ImagePreviews,
  useAttachmentsUploading,
} from "./image-attachments-ui.js";
import { useImageDropTarget } from "./image-drop-target.js";
import { ProcessingIndicator } from "./processing-indicator.js";
import { sendRefusal } from "./send-failure.js";
import {
  type ComposerMentions,
  useComposerMentions,
} from "./sharing/chat-composer.js";
import { UserMessageText } from "./sharing/message-authors.js";
import { draftMode } from "./sharing/thread-chat.js";
import {
  createPendingSubmissionControl,
  type OptimisticThreadCreation,
  type PendingSubmissionControl,
} from "./thread-session-registry.js";
import {
  INBOUND_MESSAGE_PREFIX,
  ThreadTranscript,
  type TranscriptFocus,
} from "./thread-transcript.js";
import {
  deriveTranscriptViewModel,
  type TranscriptViewModel,
} from "./transcript-view-model.js";
import {
  type AgentSource,
  agentValueSource,
  useAgentSelection,
} from "./use-frame-coalesced-agent-session.js";
import {
  type PresentationValue,
  usePresentationValue,
  useThreadPresentation,
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
  /** A Claude plan limit: the card carries the Claude mark and a usage link. */
  readonly claudePlan?: boolean;
};

const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

const resetTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const resetDayAndTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/** The reset in the reader's time; a later day names the day too. */
const claudePlanReset = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return (
    date.toDateString() === new Date().toDateString()
      ? resetTime
      : resetDayAndTime
  ).format(date);
};

const claudePlanLimitPresentation = (
  id: string,
  limit: ClaudePlanLimit,
): ThreadErrorPresentation => ({
  id,
  title: "Claude subscription limit reached",
  message: `You've hit your Claude ${
    limit.window === undefined
      ? "subscription limit"
      : claudePlanWindowName(limit.window)
  } · resets ${claudePlanReset(limit.resetsAt)}.${
    limit.cause === "exhausted"
      ? ""
      : " dx kept Claude Code off paid extra usage."
  }`,
  action: "model-routing",
  claudePlan: true,
});

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

/**
 * Core stamps a failure the person must fix (budget, credentials, plan) as
 * `(dx_failure:account:CODE)`; its text is written for the person.
 */
const accountFailureMessage = (error: unknown) => {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : errorSearchText(error);
  if (!/\(dx_failure:account:[A-Z0-9_]+\)/.test(message)) return undefined;
  return message
    .replace(/\(dx_failure:[a-z]+:[A-Z0-9_]+\)/g, "")
    .replace(/^\w+\(sub_[^)]*\) failed: /, "")
    .trim();
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

/** Core refused the run at Orb start because its source grant changed. */
const sourceAccessDenial = (error: unknown) => {
  if (typeof error !== "object" || error === null) return undefined;
  const { type, message, details } = error as Record<string, unknown>;
  if (type !== "source_authorization_denied") return undefined;
  return {
    title: typeof message === "string" ? message : "Source access needed",
    message: typeof details === "string" ? details : "",
  };
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
    const claudePlanLimit = latestSettlementFailed
      ? parseClaudePlanLimit(errorSearchText(latestSettlement.error))
      : undefined;
    if (claudePlanLimit !== undefined)
      return claudePlanLimitPresentation(
        `settlement:${latestSettlement.submissionId}`,
        claudePlanLimit,
      );
    const sourceDenied = latestSettlementFailed
      ? sourceAccessDenial(latestSettlement.error)
      : undefined;
    if (sourceDenied !== undefined)
      return {
        id: `settlement:${latestSettlement.submissionId}`,
        ...sourceDenied,
        action: "resume",
      };
    const accountFailure = latestSettlementFailed
      ? accountFailureMessage(latestSettlement.error)
      : undefined;
    if (accountFailure !== undefined)
      return {
        id: `settlement:${latestSettlement.submissionId}`,
        title: "Model connection needs attention",
        message: accountFailure,
        action: "model-routing",
      };
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
    const claudePlanLimit = parseClaudePlanLimit(
      failedSettlementMessage.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n"),
    );
    if (!dismissed.has(id) && claudePlanLimit !== undefined)
      return claudePlanLimitPresentation(id, claudePlanLimit);
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
      <aside
        className="thread-error-card"
        role="alert"
        data-kind={error.claudePlan ? "claude-plan" : undefined}
      >
        {error.claudePlan ? <ClaudeIcon /> : <AlertCircle aria-hidden="true" />}
        <div className="thread-error-copy">
          <strong>{error.title}</strong>
          <span>{error.message}</span>
          {retryAction || settingsAction || error.claudePlan ? (
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
              {error.claudePlan ? (
                <a
                  className={buttonVariants({ variant: "ghost", size: "xs" })}
                  href={CLAUDE_USAGE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink /> Check usage
                </a>
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

const sameErrorPresentation = (
  previous: ThreadErrorPresentation | undefined,
  next: ThreadErrorPresentation | undefined,
) =>
  previous === next ||
  (previous !== undefined &&
    next !== undefined &&
    previous.id === next.id &&
    previous.title === next.title &&
    previous.message === next.message &&
    previous.action === next.action &&
    previous.failedSend === next.failedSend &&
    previous.claudePlan === next.claudePlan);

/** Subscribes only to the error it shows, not to every streamed frame. */
function AgentThreadErrorCard({
  source,
  discardedSends,
  actionError,
  archived,
  onActionErrorChange,
  onOpenModelRouting,
  onRetrySend,
}: {
  readonly source: AgentSource<PanelAgent>;
  readonly discardedSends: ReadonlySet<string>;
  readonly actionError?: ThreadErrorPresentation;
  readonly archived: boolean;
  readonly onActionErrorChange: (
    error: ThreadErrorPresentation | undefined,
  ) => void;
  readonly onOpenModelRouting?: () => void;
  readonly onRetrySend: (failedSend: FailedSend) => Promise<void>;
}) {
  const [dismissed, setDismissed] = React.useState(() => new Set<string>());
  const [retrying, setRetrying] = React.useState(false);
  const agentError = useAgentSelection(
    source,
    (agent) =>
      threadErrorPresentation(keptSends(agent, discardedSends), dismissed),
    sameErrorPresentation,
  );
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
    const agent = source.getSnapshot();
    const retried = await settle(async () => {
      if (error.action === "retry-send" && error.failedSend !== undefined) {
        await onRetrySend(error.failedSend);
      } else if (error.action === "refresh") {
        agent.refresh();
        return;
      } else {
        await agent.resume();
      }
      setDismissed((current) => new Set(current).add(error.id));
    });
    if (!retried.ok)
      onActionErrorChange({
        id: "action:retry",
        title: "Retry failed",
        message: "Check your connection.",
        action: "none",
      });
    setRetrying(false);
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
    // Read both before writing, so one layout serves both. A hidden pane
    // measures zero; keep its heights so showing it changes nothing.
    const dockHeight = node.offsetHeight;
    const composerHeight = composer.offsetHeight;
    if (dockHeight === 0 && composerHeight === 0) return;
    pane.style.setProperty("--agent-composer-dock-height", `${dockHeight}px`);
    pane.style.setProperty("--agent-composer-height", `${composerHeight}px`);
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
  const enterKey = useComposerEnterKey();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!dictation.interceptSubmit()) onSubmit(draft);
  };
  // One of Send or Stop: Stop only while the agent runs and the composer is
  // empty; otherwise Send, disabled until there is something to send, so the
  // mic keeps its place.
  const composing =
    dictation.active || draft.trim() !== "" || images.length > 0;
  const showStop = stopAvailable && (draftLocked || !composing);
  const showSend = !dictation.hideSubmit && (draftLocked || !showStop);
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
          enterKeyHint={enterKey.enterKeyHint}
          disabled={draftLocked}
          readOnly={draftLocked}
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
            if (enterKey.sends(event)) {
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
          {showSend ? (
            <Button
              type="submit"
              size="icon-sm"
              className="composer-submit"
              aria-label={
                agentActive ? "Send steering message" : "Send message"
              }
              aria-busy={draftLocked || undefined}
              data-submitting={draftLocked ? "" : undefined}
              disabled={draftLocked || uploading || !composing}
            >
              {draftLocked ? (
                // The New Thread composer's mark while it creates.
                <span
                  className="processing-dot dictation-processing-dot"
                  aria-hidden="true"
                />
              ) : (
                <ArrowUp />
              )}
            </Button>
          ) : null}
          {showStop ? (
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

function useAgentSubmission({
  currentAgent,
  mentions,
  draftValue,
  images,
  setImages,
  imageCollection,
  discardSends,
  submissionPending,
  submissionControl,
  onSubmissionPendingChange,
  onAccessChanged,
}: {
  readonly onAccessChanged?: () => void;
  /** The agent as the panel shows it, read when a handler runs. */
  readonly currentAgent: () => UseFlueAgentResult;
  readonly mentions?: ComposerMentions;
  readonly draftValue: PresentationValue<string>;
  readonly images: ReadonlyArray<PendingAttachment>;
  readonly setImages: (images: ReadonlyArray<PendingAttachment>) => void;
  readonly imageCollection: PendingAttachmentCollection;
  /** Failed sends an edited message replaced; Flue has no discard. */
  readonly discardSends: (ids: ReadonlyArray<string>) => void;
  readonly submissionPending: boolean;
  readonly submissionControl: PendingSubmissionControl;
  readonly onSubmissionPendingChange?: (pending: boolean) => void;
}) {
  const [admissionPending, setAdmissionPending] = React.useState(false);
  // The latest send failed. The rendered Flue snapshot is up to a frame
  // behind, so it can still show that send's echo as pending.
  const [sendFailed, setSendFailed] = React.useState(false);
  // A chat message being admitted has no run to stop.
  const [admittingChat, setAdmittingChat] = React.useState(false);
  const submitInFlight = React.useRef(false);
  const submitGeneration = React.useRef(0);
  const [actionError, setActionError] =
    React.useState<ThreadErrorPresentation>();
  const finishAdmission = () => {
    submitInFlight.current = false;
    submissionControl.setStopRequested(false);
    onSubmissionPendingChange?.(false);
    setAdmissionPending(false);
  };
  const stopAgent = async () => {
    try {
      await currentAgent().abort();
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
      submissionControl.setStopRequested(true);
    await stopAgent();
  };
  const modeOf = (message: string) =>
    mentions?.mode === "members"
      ? draftMode(
          message,
          mentions.members,
          mentions.viewerId,
          mentions.conversationMode,
        )
      : "agent";
  /**
   * Holds the composer's message, read-only, while `deliver` sends a message,
   * and lets go of it only once the server has that message. `deliver` gets
   * the composer's message with its attachments and returns the one it sent.
   * A refusal or a lost connection leaves the composer as it was.
   */
  const admit = (
    mode: ReturnType<typeof modeOf>,
    text: string,
    deliver: (held: string) => Promise<string>,
  ) => {
    if (submitInFlight.current || submissionPending) return Promise.resolve();
    submitInFlight.current = true;
    submissionControl.setStopRequested(false);
    onSubmissionPendingChange?.(true);
    const generation = ++submitGeneration.current;
    setAdmittingChat(mode === "chat");
    setAdmissionPending(true);
    setSendFailed(false);
    setActionError(undefined);
    const runAdmission = async () => {
      try {
        await imageCollection.settle();
        if (generation !== submitGeneration.current) return;
        const held = await messageWithAttachments(text, imageCollection.list());
        const sent = await deliver(held);
        if (mentions?.mode === "members") mentions.onSent(mode);
        if (submissionControl.stopRequested()) await stopAgent();
        if (sent === held) {
          draftValue.set("");
          disposeAttachments(imageCollection.take());
          setImages([]);
        }
      } catch (cause) {
        // A refused message stays in the composer with its reason. One the
        // server may hold stays there too, and in Flue's failed send, whose
        // key an unedited Send or Retry reuses, so it cannot duplicate.
        const refusal = sendRefusal(cause);
        if (isReadOnlyRejection(cause)) onAccessChanged?.();
        setSendFailed(true);
        setActionError({
          // A Retry card for a failed send replaces only the generic error.
          id: refusal === undefined ? "action:send" : "action:send-refused",
          title: "Message not sent",
          message: refusal ?? "Check your connection.",
          action: "none",
        });
      }
    };
    return runAdmission().finally(finishAdmission);
  };
  const deliverFailedSend = (failed: FailedSend) =>
    failed.retry === "resend"
      ? currentAgent().resendPrompt(failed.id)
      : currentAgent().retrySend(failed.id);
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
    const mode = modeOf(message);
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
    await admit(mode, message, async (held) => {
      // Unedited since it failed: send it under its key again. Edited: the
      // new message replaces the failed one.
      const agent = currentAgent();
      const failed = agent.failedSends.findLast(
        ({ message: sent }) => sent === held,
      );
      if (failed !== undefined) await deliverFailedSend(failed);
      else {
        discardSends(agent.failedSends.map(({ id }) => id));
        await agent.sendMessage(held);
      }
      return held;
    });
  };
  /** The failed-send card's Retry; clears the composer if it held that one. */
  const retrySend = (failed: FailedSend) =>
    admit(modeOf(failed.message), draftValue.get().trim(), async () => {
      await deliverFailedSend(failed);
      return failed.message;
    });
  return {
    actionError,
    admissionPending,
    sendFailed,
    admittingChat,
    setActionError,
    stop,
    submit,
    retrySend,
  };
}

type PanelAgent = UseFlueAgentResult & {
  readonly hasMore?: boolean;
  readonly loadingOlder?: boolean;
  readonly olderError?: Error;
  readonly loadOlder?: () => Promise<void>;
};

export interface AgentPanelOptions {
  /** What `@` does in the composer; absent for people who cannot send. */
  readonly mentions?: ComposerMentions;
  /** A send found the user's access changed; refresh the Thread. */
  readonly onAccessChanged?: () => void;
  /** Replaces the composer for people who can only view this Thread. */
  readonly readOnlyNotice?: React.ReactNode;
  readonly agentInitialization: ThreadAgentInitializationData;
  readonly archived?: boolean;
  readonly showArchivedNotice?: boolean;
  readonly active?: boolean;
  readonly additionalPanels?: React.ReactNode;
  /** The header; `transcript` reads the shown transcript when asked. */
  readonly renderHeader?: (
    transcript: () => TranscriptViewModel,
  ) => React.ReactNode;
  /** The owner's draft; defaults to this Thread's retained composer draft. */
  readonly draft?: PresentationValue<string>;
  readonly images?: ReadonlyArray<PendingAttachment>;
  readonly onImagesChange?: (images: ReadonlyArray<PendingAttachment>) => void;
  readonly imageCollection?: PendingAttachmentCollection;
  readonly submissionPending?: boolean;
  readonly submissionControl?: PendingSubmissionControl;
  readonly onSubmissionPendingChange?: (pending: boolean) => void;
  readonly dictationAvailable?: boolean;
  readonly workspaceReady?: boolean;
  readonly workspaceStatus?: string;
  /** Shown above the error card, such as the Orb memory notice. */
  readonly composerNotice?: React.ReactNode;
  readonly optimisticCreation?: OptimisticThreadCreation;
  readonly onInitialSubmissionObserved?: (submissionId: string) => void;
  readonly onOpenModelRouting?: () => void;
  /** Messages other Threads sent while this one worked, not yet joined. */
  readonly inboundMessages?: ThreadDetailData["inboundMessages"];
  /** Open the transcript at this message, as a notification links. */
  readonly focus?: TranscriptFocus;
  readonly onFocusHandled?: () => void;
  /** The transcript is hidden behind another tab and must come forward. */
  readonly onFocusRequested?: () => void;
}

/**
 * The conversation. With a `source`, only the transcript renders each
 * streamed frame; the header, composer, and error card subscribe to the
 * values they show. An `agent` re-renders with its owner instead.
 */
type AgentPanelConversation =
  | { readonly source: AgentSource<PanelAgent>; readonly agent?: undefined }
  | { readonly agent: PanelAgent; readonly source?: undefined };

type AgentPanelProps = AgentPanelOptions & AgentPanelConversation;

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

  // Never shows an error card: an uncaptured screenshot is not an error.
  // See addScreenshot.
  const takeScreenshot = async () => {
    setImages(await addScreenshot(imageCollection));
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
  messages: PanelAgent["messages"],
  inbound: AgentPanelOptions["inboundMessages"],
  olderHistory: boolean,
): PanelAgent["messages"] => {
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
        }) as PanelAgent["messages"][number],
    ),
  ];
};

/**
 * Flue keeps a failed echo for every rejected send and offers no discard. A
 * refused send is in the composer with its reason, and one an edited message
 * replaced is gone, so both leave the Retry card and the session error.
 */
const keptSends = <Agent extends UseFlueAgentResult>(
  agent: Agent,
  discarded: ReadonlySet<string>,
): Agent => {
  const dropped = agent.failedSends.filter(
    ({ id, error }) => discarded.has(id) || sendRefusal(error) !== undefined,
  );
  if (dropped.length === 0) return agent;
  const ids = new Set(dropped.map(({ id }) => id));
  return {
    ...agent,
    failedSends: agent.failedSends.filter(({ id }) => !ids.has(id)),
    error: dropped.some(({ error }) => error === agent.error)
      ? undefined
      : agent.error,
  };
};

/** Dropped sends also leave the transcript. */
const withoutDroppedSends = <Agent extends UseFlueAgentResult>(
  agent: Agent,
  discarded: ReadonlySet<string>,
): Agent => {
  const kept = keptSends(agent, discarded);
  if (kept === agent) return agent;
  const keptIds = new Set(kept.failedSends.map(({ id }) => id));
  const droppedIds = new Set(
    agent.failedSends.flatMap(({ id }) => (keptIds.has(id) ? [] : [id])),
  );
  return {
    ...kept,
    messages: agent.messages.filter(({ id }) => !droppedIds.has(id)),
  };
};

/**
 * Flue echoes a message into the transcript before the server has it. dx
 * shows a message once it is durable: until then, and after its send fails,
 * the composer holds it. So the transcript leaves out failed echoes and, until
 * the latest send is confirmed, the newest echo Flue has not admitted.
 */
const withoutUnsentEchoes = <Agent extends UseFlueAgentResult>(
  agent: Agent,
  unconfirmed: boolean,
): Agent => {
  const failed = new Set(agent.failedSends.map(({ id }) => id));
  const pending = unconfirmed
    ? agent.messages.findLast(
        ({ id, role, submissionId }) =>
          role === "user" && submissionId === undefined && !failed.has(id),
      )
    : undefined;
  if (failed.size === 0 && pending === undefined) return agent;
  return {
    ...agent,
    messages: agent.messages.filter(
      ({ id }) => !failed.has(id) && id !== pending?.id,
    ),
  };
};

/** What the transcript leaves out or adds to Flue's history. */
interface TranscriptView {
  readonly discardedSends: ReadonlySet<string>;
  /** The latest send is not confirmed; its echo stays in the composer. */
  readonly unconfirmed: boolean;
  readonly inboundMessages: AgentPanelOptions["inboundMessages"];
  readonly chatEcho: ((text: string) => boolean) | undefined;
}

interface ShownTranscript {
  readonly agent: PanelAgent;
  readonly model: TranscriptViewModel;
}

const EMPTY_TRANSCRIPT = deriveTranscriptViewModel({
  messages: [],
  settlements: [],
});

/**
 * Derives the shown transcript once per Flue snapshot and view, shared by
 * the transcript and the run state. Each derivation reuses the previous
 * model's unchanged turns and rows, so a streamed frame rebuilds only what
 * changed; `current` reads the latest model for an export.
 */
const createTranscriptDerivation = () => {
  let last:
    | {
        readonly agent: PanelAgent;
        readonly view: TranscriptView;
        readonly shown: ShownTranscript;
      }
    | undefined;
  let model: TranscriptViewModel | undefined;
  let modelInputs: ReadonlyArray<unknown> = [];
  const sameView = (previous: TranscriptView, next: TranscriptView) =>
    previous.discardedSends === next.discardedSends &&
    previous.unconfirmed === next.unconfirmed &&
    previous.inboundMessages === next.inboundMessages &&
    previous.chatEcho === next.chatEcho;
  const derive = (observed: PanelAgent, view: TranscriptView) => {
    if (
      last !== undefined &&
      last.agent === observed &&
      sameView(last.view, view)
    )
      return last.shown;
    const agent = withoutUnsentEchoes(
      withoutDroppedSends(observed, view.discardedSends),
      view.unconfirmed,
    );
    const inputs = [
      agent.messages,
      agent.settlements,
      agent.finalOutputs,
      agent.historyReady,
      agent.hasMore,
      view.inboundMessages,
      view.chatEcho,
    ];
    if (
      model === undefined ||
      inputs.some((input, index) => input !== modelInputs[index])
    ) {
      model = deriveTranscriptViewModel(
        {
          // After history loads: a pending message ahead of it would move
          // once history arrives.
          messages: agent.historyReady
            ? withInboundMessages(
                agent.messages,
                view.inboundMessages,
                agent.hasMore === true,
              )
            : agent.messages,
          settlements: agent.settlements,
          finalOutputs: agent.finalOutputs,
          chatEcho: view.chatEcho,
        },
        model,
      );
      modelInputs = inputs;
    }
    const shown = { agent, model };
    last = { agent: observed, view, shown };
    return shown;
  };
  return { derive, current: () => model ?? EMPTY_TRANSCRIPT };
};

/**
 * Only chat is on its way and nothing runs: the agent is not working. The
 * composer's pending message has no row yet, so its own mode counts.
 */
const sendingOnlyChat = (model: TranscriptViewModel, admittingChat: boolean) =>
  (admittingChat ||
    model.rows.some((row) => row.kind === "user-prompt" && !row.admitted)) &&
  model.rows.every(
    (row) => row.kind !== "user-prompt" || row.admitted || row.chat === true,
  ) &&
  !model.turns.some((turn) => turn.status === "active");

/** The transcript, the one part of the panel that renders every frame. */
function AgentConversation({
  source,
  transcripts,
  view,
  agentInitialization,
  archived,
  active,
  showProcessingIndicator,
  footer,
  optimisticCreation,
  onInitialSubmissionObserved,
  focus,
  onFocusHandled,
  onFocusRequested,
}: {
  readonly source: AgentSource<PanelAgent>;
  readonly transcripts: ReturnType<typeof createTranscriptDerivation>;
  readonly view: TranscriptView;
  readonly agentInitialization: ThreadAgentInitializationData;
  readonly archived: boolean;
  readonly active: boolean;
  readonly showProcessingIndicator: boolean;
  readonly footer: React.ReactNode;
  readonly optimisticCreation?: OptimisticThreadCreation;
  readonly onInitialSubmissionObserved?: (submissionId: string) => void;
  readonly focus?: TranscriptFocus;
  readonly onFocusHandled?: () => void;
  readonly onFocusRequested?: () => void;
}) {
  const observed = React.useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );
  const { agent, model } = transcripts.derive(observed, view);
  const initialSubmissionObserved =
    optimisticCreation?.submissionId !== undefined &&
    agent.messages.some(
      (message) =>
        message.role === "user" &&
        message.submissionId === optimisticCreation.submissionId,
    );
  const initialSubmissionId = optimisticCreation?.submissionId;
  const reconcileInitialSubmission = (node: HTMLSpanElement | null) => {
    if (
      node === null ||
      initialSubmissionId === undefined ||
      onInitialSubmissionObserved === undefined
    )
      return;
    queueMicrotask(() => onInitialSubmissionObserved(initialSubmissionId));
  };
  return (
    <ThreadTranscript
      model={model}
      active={active}
      historyReady={agent.historyReady}
      hasMore={agent.hasMore}
      loadingOlder={agent.loadingOlder}
      olderError={agent.olderError}
      loadOlder={agent.loadOlder}
      {...(focus === undefined
        ? {}
        : { focus, onFocusHandled, onFocusRequested })}
      showProcessingIndicator={showProcessingIndicator}
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
        optimisticCreation === undefined ? null : initialSubmissionObserved ? (
          <span hidden ref={reconcileInitialSubmission} />
        ) : (
          <OptimisticInitialMessage creation={optimisticCreation} />
        )
      }
      footer={footer}
    />
  );
}

const composerDockRef = (node: HTMLDivElement | null) =>
  node === null ? undefined : observeComposerDock(node);

export function AgentPanel({
  source: retainedSource,
  agent: renderedAgent,
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
  submissionPending = false,
  submissionControl: retainedSubmissionControl,
  onSubmissionPendingChange,
  dictationAvailable = false,
  workspaceReady = false,
  workspaceStatus,
  composerNotice,
  optimisticCreation,
  onInitialSubmissionObserved,
  onOpenModelRouting,
  inboundMessages,
  readOnlyNotice,
  onAccessChanged,
  mentions,
  focus,
  onFocusHandled,
  onFocusRequested,
}: AgentPanelProps) {
  const source =
    retainedSource ?? agentValueSource(renderedAgent as PanelAgent);
  const [discardedSends, setDiscardedSends] = useThreadPresentation<
    ReadonlySet<string>
  >("discarded-sends", () => new Set());
  const retainedDraft = useThreadPresentationValue("draft", "");
  const draftValue = ownerDraft ?? retainedDraft;
  const { images, setImages, imageCollection } = usePendingImages(
    controlledImages,
    onImagesChange,
    retainedImageCollection,
  );
  const [localSubmissionControl] = React.useState(
    createPendingSubmissionControl,
  );
  const submissionControl = retainedSubmissionControl ?? localSubmissionControl;
  const {
    actionError,
    admissionPending,
    sendFailed,
    admittingChat,
    setActionError,
    stop,
    submit,
    retrySend,
  } = useAgentSubmission({
    currentAgent: () =>
      withoutDroppedSends(source.getSnapshot(), discardedSends),
    mentions,
    draftValue,
    images,
    setImages,
    imageCollection,
    discardSends: (ids) => {
      if (ids.length > 0)
        setDiscardedSends((current) => new Set([...current, ...ids]));
    },
    submissionPending,
    submissionControl,
    onSubmissionPendingChange,
    onAccessChanged,
  });
  // A message being sent as chat starts no run; recognize its local echo.
  const chatEcho =
    mentions?.mode === "members"
      ? (text: string) =>
          draftMode(
            text,
            mentions.members,
            mentions.viewerId,
            mentions.conversationMode,
          ) === "chat"
      : undefined;
  const [transcripts] = React.useState(createTranscriptDerivation);
  const view: TranscriptView = {
    discardedSends,
    unconfirmed: admissionPending || submissionPending || sendFailed,
    inboundMessages,
    chatEcho,
  };
  // The run state changes a few times per reply, not per streamed frame.
  const status = useAgentSelection(source, (agent) => agent.status);
  const onlyChat = useAgentSelection(
    source,
    (agent) =>
      agent.status === "submitted" &&
      sendingOnlyChat(
        transcripts.derive(agent, view).model,
        admissionPending && admittingChat,
      ),
  );
  const agentActive =
    (status === "submitted" && !onlyChat) || status === "streaming";
  const draftLocked = admissionPending || submissionPending;
  const stopAvailable = agentActive || (admissionPending && !admittingChat);
  const statusMessage =
    workspaceStatus ??
    (status === "submitted" && !onlyChat && !workspaceReady
      ? "Preparing workspace…"
      : undefined);

  const { addImages, takeScreenshot } = useImageActions(
    imageCollection,
    setImages,
    setActionError,
  );

  const composerLifetimeRef = (node: HTMLFormElement | null) => {
    if (node === null || retainedImageCollection !== undefined) return;
    return () =>
      void imageCollection.settle().then(() => imageCollection.dispose());
  };
  const errorCard = (
    <>
      {composerNotice}
      <AgentThreadErrorCard
        source={source}
        discardedSends={discardedSends}
        actionError={actionError}
        archived={archived}
        onActionErrorChange={setActionError}
        onOpenModelRouting={onOpenModelRouting}
        onRetrySend={retrySend}
      />
    </>
  );

  return (
    <div
      className="agent-panel-stack"
      data-archived={archived ? "" : undefined}
    >
      {renderHeader?.(transcripts.current)}
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
        <AgentConversation
          source={source}
          transcripts={transcripts}
          view={view}
          agentInitialization={agentInitialization}
          archived={archived}
          active={active}
          showProcessingIndicator={!archived && statusMessage === undefined}
          footer={
            archived ? (
              errorCard
            ) : (
              <AgentTranscriptFooter statusMessage={statusMessage} />
            )
          }
          optimisticCreation={optimisticCreation}
          onInitialSubmissionObserved={onInitialSubmissionObserved}
          focus={focus}
          onFocusHandled={onFocusHandled}
          onFocusRequested={onFocusRequested}
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
