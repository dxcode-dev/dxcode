import {
  type ThreadDetailData,
  type ThreadQueuedMessage,
  threadSettlementProvenance,
  withMessageAuthor,
} from "@dx/api";
import {
  attachmentsUploading,
  deriveTranscriptViewModel,
  INBOUND_MESSAGE_PREFIX,
  keptSends,
  messageWithAttachments,
  NO_LOCAL_SUBMISSIONS,
  sameLocalSubmissions,
  sendRefusal,
  type TranscriptViewModel,
  waitingSubmissionOf,
  withoutDroppedSends,
  withoutUnsentEchoes,
  withoutWithdrawn,
  withQueuedMessages,
} from "@dx/client";
import {
  type ClaudePlanLimit,
  parseClaudePlanLimit,
  THREAD_SNOOZE_UNTIL_NEEDED_MS,
  threadSnoozeState,
} from "@dx/domain";
import type {
  FailedSend,
  FlueClient,
  FlueConversationPrompt,
  FlueHistoryWindow,
  UseFlueAgentResult,
} from "@flue/react";
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
import { lazyComponent } from "../../shared/stale-chunk.js";
import { useOptionalThreadSnooze } from "../../shared/thread-snooze.js";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import {
  CLAUDE_USAGE_URL,
  claudePlanLimitCopy,
} from "../../shared/ui/claude-plan-limit.js";
import { Textarea } from "../../shared/ui/textarea.js";
import { observeComposerDock } from "./composer-dock.js";
import { useComposerEnterKey } from "./composer-enter-key.js";
import { useDictation } from "./dictation/use-dictation.js";
import {
  addScreenshot,
  createPendingAttachmentCollection,
  disposeAttachments,
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
import { useMessageDeleting } from "./message-delete.js";
import { useMessageEditing } from "./message-edit.js";
import {
  MessageEditContext,
  type MessageEditOptions,
} from "./message-edit-model.js";
import { ProcessingIndicator } from "./processing-indicator.js";
import {
  type ComposerMentions,
  useComposerMentions,
} from "./sharing/chat-composer.js";
import { UserMessageText } from "./sharing/message-authors.js";
import { draftMode } from "./sharing/thread-chat.js";
import { ThreadPresentationContext } from "./thread-session-context.js";
import {
  createPendingSubmissionControl,
  type OptimisticThreadCreation,
  type PendingSubmissionControl,
} from "./thread-session-registry.js";
import {
  ThreadTranscript,
  TRANSCRIPT_FOLLOW_ON_SEND,
  type TranscriptFocus,
} from "./thread-transcript.js";
import type { TranscriptAccess } from "./transcript-access.js";
import type { TranscriptReply } from "./transcript-selection-popup.js";
import { registeredTurnStop } from "./turn-stop-registration.js";
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

/**
 * The quick-action row's code loads when a row first shows, after the
 * composer has painted, so it stays out of the Thread page's first load. A
 * chunk that cannot load shows no row.
 */
const ClefQuickActions = lazyComponent(() =>
  import("./thread-quick-actions.js").then(
    (module) => ({ default: module.ClefQuickActions }),
    () => ({ default: () => null }),
  ),
);

/**
 * The composer's quick-action row (experimental). It follows the agent's
 * response that ends the conversation, while the agent waits: none after a
 * failed or stopped turn, or once anything newer arrives. Reply chips hide
 * while the person types or attaches, so a click never takes what they
 * wrote. Everything here uses code the page already has; the row, its Clef
 * request, and who may snooze load late.
 */
function ComposerQuickActions({
  source,
  thread,
  draft,
  attaching,
  onReply,
}: {
  readonly source: AgentSource<PanelAgent>;
  readonly thread: ThreadDetailData;
  readonly draft: PresentationValue<string>;
  readonly attaching: boolean;
  readonly onReply: (reply: string) => void;
}) {
  const endingReplyId = useAgentSelection(source, (agent) => {
    if (agent.status === "submitted" || agent.status === "streaming")
      return undefined;
    const last = agent.messages.findLast(({ role }) => role !== "system");
    return last?.purpose === "assistant" && last.settlement === undefined
      ? last.id
      : undefined;
  });
  const typing = usePresentationValue(draft).trim() !== "";
  const snooze = useOptionalThreadSnooze();
  if (endingReplyId === undefined) return null;
  return (
    <React.Suspense fallback={null}>
      <ClefQuickActions
        thread={thread}
        messageId={endingReplyId}
        composing={typing || attaching}
        replyIcon={<ArrowUp />}
        onReply={onReply}
        snoozedAt={(now) => threadSnoozeState(thread, now) === "snoozed"}
        {...(snooze === undefined
          ? {}
          : {
              snoozeUntilNeeded: () =>
                snooze.snooze(
                  thread.id,
                  new Date(THREAD_SNOOZE_UNTIL_NEEDED_MS),
                ),
            })}
      />
    </React.Suspense>
  );
}

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

const INITIAL_DISPATCH_FAILURE_REASONS: Record<
  NonNullable<ThreadDetailData["initialDispatch"]> extends infer Dispatch
    ? Dispatch extends { readonly failureCode: infer Code extends string }
      ? Code
      : never
    : never,
  string
> = {
  INITIAL_MESSAGE_REJECTED: "The agent refused it.",
  INITIAL_MESSAGE_TOO_LARGE: "It is too large for the agent.",
  INITIAL_SUBMISSION_CONFLICT:
    "The agent already holds a different first message.",
  INITIAL_ADMISSION_UNAVAILABLE: "The agent could not be reached.",
};

/**
 * A new Thread's first message never reached the agent. The card floats
 * above the composer with Retry, which hands the same stored message to the
 * agent again; the transcript stays blank. A message sent instead replaces
 * it, so the card goes once the conversation holds one.
 */
function InitialDispatchFailureCard({
  source,
  initialDispatch,
  onRetry,
}: {
  readonly source: AgentSource<PanelAgent>;
  readonly initialDispatch?: ThreadDetailData["initialDispatch"];
  readonly onRetry?: () => Promise<void>;
}) {
  const started = useAgentSelection(source, (agent) =>
    agent.messages.some(({ role }) => role === "user"),
  );
  const [dismissed, setDismissed] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const [retryFailed, setRetryFailed] = React.useState(false);
  if (
    started ||
    dismissed ||
    initialDispatch?.state !== "failed" ||
    onRetry === undefined
  )
    return null;
  const retry = async () => {
    setRetrying(true);
    setRetryFailed(false);
    const retried = await settle(onRetry);
    setRetryFailed(!retried.ok);
    setRetrying(false);
  };
  return (
    <div data-initial-dispatch-failure="">
      <ThreadErrorCard
        error={{
          id: "initial-dispatch",
          title: "Your message didn't start",
          message: retryFailed
            ? "Retry failed. Check your connection and try again."
            : `${INITIAL_DISPATCH_FAILURE_REASONS[initialDispatch.failureCode]} Retry sends it again.`,
          action: "none",
        }}
        retrying={retrying}
        onDismiss={() => setDismissed(true)}
        onRetry={() => void retry()}
      />
    </div>
  );
}

function AgentTranscriptHeader({
  archived,
  historyReady,
  messageCount,
  blank = false,
}: {
  readonly archived: boolean;
  readonly historyReady: boolean;
  readonly messageCount: number;
  /** Nothing to show: the first message failed; the composer's card says why. */
  readonly blank?: boolean;
}) {
  if (blank) return null;
  return (
    <>
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
  idleEnd,
}: {
  readonly statusMessage?: string;
  /** Shown while no run is active, such as when the schedule runs next. */
  readonly idleEnd?: React.ReactNode;
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
      {idleEnd}
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
  /** An app page that fixes it, such as where to add credits. */
  readonly link?: { readonly actionLabel: string; readonly actionHref: string };
};

const claudePlanLimitPresentation = (
  id: string,
  limit: ClaudePlanLimit,
): ThreadErrorPresentation => ({
  id,
  ...claudePlanLimitCopy(limit),
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

/**
 * The Orb's disk filled up and even dx's reserve could not make room
 * (`(dx_failure:…:WORKSPACE_DISK_FULL)`). Its first sentence names the
 * limit; the disk notice above the card offers the ways to free space.
 * Or Claude Code could not start on a disk that turned read-only or returns
 * I/O errors (`WORKSPACE_READ_ONLY`, #1843): the next turn's activation
 * restarts the Orb, so Retry repairs it.
 */
/**
 * A turn on a model the installation provides as dx, stopped by dx itself:
 * the deployment's own billing stopped it (its registered `TurnStop`), or
 * an admin took the model offline. Says what happened and what to do, never
 * the upstream.
 */
const dxModelStopPresentation = (
  id: string,
  text: string,
): ThreadErrorPresentation | undefined => {
  const stop = registeredTurnStop?.(text);
  if (stop !== undefined) return { id, ...stop, action: "resume" };
  if (/\(dx_failure:[a-z]+:DX_MODEL_UNAVAILABLE\)/.test(text))
    return {
      id,
      title: "This dx model is unavailable",
      message:
        "This dx model is unavailable right now. Pick another model below, or retry later.",
      action: "resume",
    };
  return undefined;
};

const diskFullPresentation = (
  id: string,
  text: string,
): ThreadErrorPresentation | undefined => {
  if (/:WORKSPACE_READ_ONLY\)/.test(text))
    return {
      id,
      title: "The Orb's disk is failing",
      message: "Retry copies your unsaved work out and restarts the Orb.",
      action: "resume",
    };
  if (!/\(dx_failure:[a-z]+:WORKSPACE_DISK_FULL\)/.test(text)) return undefined;
  // "(20 GB limit)" and the like, when Core's text names the limit.
  const limit = /Workspace disk is full( \([^)]*\))?/.exec(text)?.[1] ?? "";
  const title = `Orb disk full${limit}`;
  return {
    id,
    title,
    message:
      "dx cleared package caches and temporary files and still couldn’t make room. Retry starts the agent in recovery mode so it can free space, or delete files you don’t need from the disk notice or the Terminal.",
    action: "resume",
  };
};

/**
 * The project's pre-clone script failed, so dx did not clone the repository
 * (`(dx_failure:…:PRE_CLONE_SCRIPT_FAILED)`). Core's text says how it failed
 * and ends with its output.
 */
const preCloneFailurePresentation = (
  id: string,
  text: string,
): ThreadErrorPresentation | undefined => {
  const stamp = /\(dx_failure:[a-z]+:PRE_CLONE_SCRIPT_FAILED\)/.exec(text);
  if (stamp === null) return undefined;
  const start = text.indexOf("The project's pre-clone script");
  return {
    id,
    title: "Pre-clone script failed",
    message: text.slice(Math.max(start, 0), stamp.index).trim(),
    action: "resume",
  };
};

/**
 * The Thread runs a plugin's agent, and the plugin no longer runs for its
 * owner: dx refused the turn rather than run it as plain dx. Retry once the
 * plugin is enabled or installed again.
 */
const pluginAgentFailurePresentation = (
  id: string,
  text: string,
): ThreadErrorPresentation | undefined => {
  const stamp = /\(dx_failure:[a-z]+:PLUGIN_AGENT_UNAVAILABLE\)/.exec(text);
  if (stamp === null) return undefined;
  const start = text.indexOf("This Thread runs the");
  return {
    id,
    title: "Plugin agent unavailable",
    message: text.slice(Math.max(start, 0), stamp.index).trim(),
    action: "resume",
  };
};

/**
 * Core refused the run at Orb start: its source grant changed, or the
 * deployment's Orb billing policy refused it with a reason. Or the Orb's
 * disk is failing (read-only or I/O errors), and the details say what dx
 * did about it.
 */
const orbStartDenial = (error: unknown) => {
  if (typeof error !== "object" || error === null) return undefined;
  const { type, message, details } = error as Record<string, unknown>;
  if (type === "workspace_read_only")
    return {
      title: "The Orb's disk is failing",
      message: typeof details === "string" ? details : "",
    };
  if (type === "workspace_unresponsive")
    return {
      title: "The Orb stopped responding",
      message: typeof details === "string" ? details : "",
    };
  // A runner Thread's machine was removed: nothing brings it back.
  if (type === "runner_removed")
    return {
      title: typeof message === "string" ? message : "The runner was removed",
      message: typeof details === "string" ? details : "",
    };
  // A runner Thread's machine lacks git (on a Mac, the Command Line Tools):
  // the details say what to install; Retry once it is.
  if (type === "runner_prerequisites_missing")
    return {
      title:
        typeof message === "string"
          ? message
          : "The runner is missing a prerequisite",
      message: typeof details === "string" ? details : "",
    };
  // A runner Thread's machine is not connected: Retry once it is back.
  if (type === "runner_offline")
    return {
      title: typeof message === "string" ? message : "The runner is offline",
      message: typeof details === "string" ? details : "",
    };
  // Core's 5-minute limit on an Orb start (#1956): Retry waits for it.
  if (type === "orb_start_timed_out")
    return {
      title: typeof message === "string" ? message : "The Orb is slow to start",
      message: typeof details === "string" ? details : "",
    };
  // The provider account has no Orb template for the size (#1936).
  if (type === "orb_template_missing")
    return {
      title: typeof message === "string" ? message : "Orb template missing",
      message: typeof details === "string" ? details : "",
    };
  if (type === "orb_start_refused") {
    const action = (error as { meta?: ThreadErrorPresentation["link"] }).meta;
    return {
      title: "Orb not started",
      message: typeof message === "string" ? message : "",
      // Only a page of this app: never a link the error could send elsewhere.
      link: /^\/\w/.test(action?.actionHref ?? "") ? action : undefined,
    };
  }
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
    const diskFull = latestSettlementFailed
      ? diskFullPresentation(
          `settlement:${latestSettlement.submissionId}`,
          errorSearchText(latestSettlement.error),
        )
      : undefined;
    if (diskFull !== undefined) return diskFull;
    const dxModelStop = latestSettlementFailed
      ? dxModelStopPresentation(
          `settlement:${latestSettlement.submissionId}`,
          errorSearchText(latestSettlement.error),
        )
      : undefined;
    if (dxModelStop !== undefined) return dxModelStop;
    const preCloneFailure = latestSettlementFailed
      ? preCloneFailurePresentation(
          `settlement:${latestSettlement.submissionId}`,
          errorSearchText(latestSettlement.error),
        )
      : undefined;
    if (preCloneFailure !== undefined) return preCloneFailure;
    const pluginAgentFailure = latestSettlementFailed
      ? pluginAgentFailurePresentation(
          `settlement:${latestSettlement.submissionId}`,
          errorSearchText(latestSettlement.error),
        )
      : undefined;
    if (pluginAgentFailure !== undefined) return pluginAgentFailure;
    const startDenied = latestSettlementFailed
      ? orbStartDenial(latestSettlement.error)
      : undefined;
    if (startDenied !== undefined)
      return {
        id: `settlement:${latestSettlement.submissionId}`,
        ...startDenied,
        action: "resume",
      };
    const accountFailure = latestSettlementFailed
      ? accountFailureMessage(latestSettlement.error)
      : undefined;
    if (accountFailure !== undefined) {
      // A run that started, or reached the model, after its Thread was
      // archived (#1849, #1668): nothing to fix in Model Routing.
      const archived = errorSearchText(latestSettlement.error).includes(
        ":THREAD_ARCHIVED)",
      );
      return {
        id: `settlement:${latestSettlement.submissionId}`,
        title: archived
          ? "Archived thread"
          : "Model connection needs attention",
        message: accountFailure,
        action: archived ? "none" : "model-routing",
      };
    }
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
    const failureText = failedSettlementMessage.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    const claudePlanLimit = parseClaudePlanLimit(failureText);
    if (!dismissed.has(id) && claudePlanLimit !== undefined)
      return claudePlanLimitPresentation(id, claudePlanLimit);
    const diskFull = diskFullPresentation(id, failureText);
    if (!dismissed.has(id) && diskFull !== undefined) return diskFull;
    const dxModelStop = dxModelStopPresentation(id, failureText);
    if (!dismissed.has(id) && dxModelStop !== undefined) return dxModelStop;
    const preCloneFailure = preCloneFailurePresentation(id, failureText);
    if (!dismissed.has(id) && preCloneFailure !== undefined)
      return preCloneFailure;
    const pluginAgentFailure = pluginAgentFailurePresentation(id, failureText);
    if (!dismissed.has(id) && pluginAgentFailure !== undefined)
      return pluginAgentFailure;
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
          {retryAction || settingsAction || error.claudePlan || error.link ? (
            <div className="thread-error-actions">
              {error.link && (
                <a
                  className={buttonVariants({ variant: "ghost", size: "xs" })}
                  href={error.link.actionHref}
                >
                  {error.link.actionLabel}
                </a>
              )}
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
          variant="subtle"
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
      threadErrorPresentation(
        withoutWithdrawn(keptSends(agent, discardedSends)),
        dismissed,
      ),
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

function AgentComposer({
  editing,
  focusRef,
  agentActive,
  quickActions,
  stopAvailable,
  dictationAvailable,
  draftValue,
  draftLocked,
  images,
  errorCard,
  modelControl,
  dockRef,
  mentions,
  onAbort,
  onAddImages,
  onRemoveImage,
  onSubmit,
  onTakeScreenshot,
  replyRef,
  ref,
}: {
  /**
   * Editing an earlier message: the bar above the box, and Cancel, which
   * Esc in the box also chooses. The message's files show with Remove.
   */
  readonly editing?: {
    readonly bar: React.ReactNode;
    /** The message's files, each with Remove; the edit sends the rest. */
    readonly attachments?: React.ReactNode;
    readonly keptAttachments?: number;
    readonly onCancel: () => void;
  };
  /** Focuses the box with the caret at the end, as starting an edit does. */
  readonly focusRef?: React.RefObject<(() => void) | undefined>;
  /** Set to quote text into the draft, from a transcript selection. */
  readonly replyRef?: React.RefObject<TranscriptReply | undefined>;
  readonly mentions?: ComposerMentions;
  readonly agentActive: boolean;
  /** The quick-action row, which hides while a message is being sent. */
  readonly quickActions?: React.ReactNode;
  readonly stopAvailable: boolean;
  readonly dictationAvailable: boolean;
  /** Only the composer subscribes, so typing never re-renders the transcript. */
  readonly draftValue: PresentationValue<string>;
  readonly draftLocked: boolean;
  readonly images: ReadonlyArray<PendingAttachment>;
  readonly errorCard?: React.ReactNode;
  /** The Thread's model picker; hidden while an earlier message is edited. */
  readonly modelControl?: React.ReactNode;
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
    disabled: draftLocked || uploading || editing !== undefined,
    onFiles: onAddImages,
  });
  const composerMentions = useComposerMentions({
    mentions,
    draft,
    setDraft: onChangeDraft,
    textareaRef,
  });
  React.useImperativeHandle(replyRef, () => (quote, dictate) => {
    if (draftLocked) return;
    const current = draftValue.get();
    const next =
      current.trim() === ""
        ? quote
        : `${current.replace(/\s*$/, "")}\n\n${quote}`;
    onChangeDraft(next);
    // After React writes the draft: the caret goes below the quote.
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      textarea.focus();
      textarea.setSelectionRange(next.length, next.length);
      if (dictate) dictation.start();
    });
  });
  React.useImperativeHandle(focusRef, () => () => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  });
  const enterKey = useComposerEnterKey();
  // While a send is admitted the draft holds that message, which cannot
  // change, and the box keeps focus: what the viewer types goes after it and
  // becomes the next draft once the send settles.
  const [typedWhileSending, setTypedWhileSending] = React.useState("");
  // A send from the Send button disables that button, which drops its focus;
  // the cursor comes back to the draft once it unlocks.
  const refocusAfterSend = React.useRef(false);
  const attachTextarea = (node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    if (node === null || draftLocked) return;
    if (typedWhileSending !== "") {
      setTypedWhileSending("");
      onChangeDraft(`${draftValue.get()}${typedWhileSending}`);
    }
    if (!refocusAfterSend.current) return;
    refocusAfterSend.current = false;
    if (document.activeElement === document.body) node.focus();
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (dictation.interceptSubmit()) return;
    refocusAfterSend.current = event.currentTarget.contains(
      document.activeElement,
    );
    onSubmit(draft);
  };
  // One of Send or Stop: Stop only while the agent runs and the composer is
  // empty; otherwise Send, disabled until there is something to send, so the
  // mic keeps its place. A message on its way (a dictation sent while
  // recording, or a send not yet admitted) shows no Stop: it sends anyway.
  const composing =
    dictation.active ||
    draft.trim() !== "" ||
    images.length > 0 ||
    (editing?.keptAttachments ?? 0) > 0;
  const showStop = stopAvailable && !draftLocked && !composing;
  const showSend = !dictation.hideSubmit && !showStop;
  return (
    <div className="agent-composer-dock" ref={dockRef}>
      {errorCard}
      {composerMentions.popover}
      {composerMentions.banner}
      {draftLocked || editing !== undefined ? null : quickActions}
      {editing?.bar}
      <form
        className="agent-composer"
        data-chat-mode={composerMentions.chatMode ? "" : undefined}
        data-editing={editing === undefined ? undefined : ""}
        onSubmit={submit}
        ref={ref}
        {...dropTarget}
      >
        <Textarea
          variant="bare"
          ref={attachTextarea}
          aria-label="Message"
          data-command-target="thread-composer"
          enterKeyHint={enterKey.enterKeyHint}
          aria-busy={draftLocked || undefined}
          value={`${draft}${typedWhileSending}`}
          {...composerMentions.textareaProps}
          onChange={(event) => {
            if (draftLocked) {
              // Only what follows the message being sent can change.
              const next = event.target.value;
              if (next.startsWith(draft))
                setTypedWhileSending(next.slice(draft.length));
              return;
            }
            onChangeDraft(event.target.value);
            composerMentions.onInput(event);
          }}
          onSelect={composerMentions.trackCaret}
          onPaste={(event) => {
            const files = pastedFiles(event);
            if (
              files.length === 0 ||
              draftLocked ||
              uploading ||
              editing !== undefined
            )
              return;
            event.preventDefault();
            onAddImages(files);
          }}
          onKeyDown={(event) => {
            if (composerMentions.onKeyDown(event)) {
              event.preventDefault();
              return;
            }
            if (
              editing !== undefined &&
              event.key === "Escape" &&
              !draftLocked
            ) {
              event.preventDefault();
              editing.onCancel();
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
            disabled={draftLocked || uploading || editing !== undefined}
            onFiles={onAddImages}
            onScreenshot={onTakeScreenshot}
          />
          {editing?.attachments ?? (
            <ImagePreviews
              images={images}
              onRemove={onRemoveImage}
              disabled={draftLocked}
            />
          )}
          {editing === undefined ? modelControl : null}
          <span className="composer-spacer" />
          {dictation.controls}
          {showSend ? (
            <Button
              type="submit"
              size="icon-xs"
              shape="round"
              className="composer-submit"
              aria-label={
                editing !== undefined
                  ? "Send edited message"
                  : agentActive
                    ? "Send steering message"
                    : "Send message"
              }
              busy={draftLocked}
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
              size="icon-xs"
              shape="round"
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
  readonly historyWindow?: FlueHistoryWindow;
  readonly openHistoryWindow?: (cursor: string) => Promise<void>;
  readonly loadWindowOlder?: () => Promise<void>;
  readonly loadWindowNewer?: () => Promise<void>;
  readonly closeHistoryWindow?: () => void;
};

export interface AgentPanelOptions {
  /** What `@` does in the composer; absent for people who cannot send. */
  readonly mentions?: ComposerMentions;
  /** A send found the user's access changed; refresh the Thread. */
  readonly onAccessChanged?: () => void;
  /** Replaces the composer for people who can only view this Thread. */
  readonly readOnlyNotice?: React.ReactNode;
  readonly archived?: boolean;
  /** In the composer's place while the Thread is archived. */
  readonly archivedComposer?: React.ReactNode;
  readonly showArchivedNotice?: boolean;
  /** The Thread's Project was deleted, so it can never be unarchived. */
  readonly projectDeleted?: boolean;
  /** dx removed the Thread's unused Orb, so it can never be unarchived. */
  readonly orbRemoved?: boolean;
  readonly active?: boolean;
  readonly additionalPanels?: React.ReactNode;
  /** The header; `transcript` reads the shown transcript when asked. */
  readonly renderHeader?: (
    transcript: () => TranscriptViewModel,
  ) => React.ReactNode;
  /** Lets a title bar outside the panel read the shown transcript. */
  readonly transcriptAccess?: TranscriptAccess;
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
  /**
   * Shown above the error card, such as the Orb memory and disk notices.
   * As a function it gets `send`, which sends a message as the composer
   * would, and the panel's agent to select from.
   */
  readonly composerNotice?:
    | React.ReactNode
    | ((
        send: (message: string) => void,
        source: AgentSource<UseFlueAgentResult>,
      ) => React.ReactNode);
  /** The transcript's last line while no run is active. */
  readonly transcriptEnd?: React.ReactNode;
  /** The Thread's model and effort, beside the composer's attachments. */
  readonly composerModel?: React.ReactNode;
  /**
   * The composer quick-action row, which Clef Flash fills once the agent's
   * turn ends: present only while the deployment has Clef Flash and this
   * person can send.
   */
  readonly quickActions?: { readonly thread: ThreadDetailData };
  readonly optimisticCreation?: OptimisticThreadCreation;
  readonly onInitialSubmissionObserved?: (submissionId: string) => void;
  /** The first message while the agent has not admitted it. */
  readonly initialDispatch?: ThreadDetailData["initialDispatch"];
  /** Retry on a first message that failed to start. */
  readonly onRetryInitialDispatch?: () => Promise<void>;
  readonly onOpenModelRouting?: () => void;
  /** Messages other Threads sent while this one worked, not yet joined. */
  readonly inboundMessages?: ThreadDetailData["inboundMessages"];
  /** Open the transcript at this message, as a notification links. */
  readonly focus?: TranscriptFocus;
  readonly onFocusHandled?: () => void;
  /** The transcript is hidden behind another tab and must come forward. */
  readonly onFocusRequested?: () => void;
  /** Edit an earlier message; absent where the viewer may not. */
  readonly messageEdit?: MessageEditOptions;
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

/** What the transcript leaves out or adds to Flue's history. */
interface TranscriptView {
  readonly discardedSends: ReadonlySet<string>;
  /** The latest send is not confirmed; its echo stays in the composer. */
  readonly unconfirmed: boolean;
  readonly inboundMessages: AgentPanelOptions["inboundMessages"];
  /** The viewer's own messages waiting in the queue, from the server. */
  readonly queuedMessages: ReadonlyArray<ThreadQueuedMessage> | undefined;
  readonly chatEcho: ((text: string) => boolean) | undefined;
  readonly admittedMessageId:
    | ((submissionId: string) => string | undefined)
    | undefined;
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
    previous.queuedMessages === next.queuedMessages &&
    previous.chatEcho === next.chatEcho &&
    previous.admittedMessageId === next.admittedMessageId;
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
      view.queuedMessages,
      agent.localSubmissions,
      view.chatEcho,
      view.admittedMessageId,
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
            ? withQueuedMessages(
                withInboundMessages(
                  agent.messages,
                  view.inboundMessages,
                  agent.hasMore === true,
                ),
                view.queuedMessages,
                agent.localSubmissions,
              )
            : agent.messages,
          // A withdrawn message ran nothing; it shows no stopped turn.
          settlements: withoutWithdrawn(agent).settlements,
          finalOutputs: agent.finalOutputs,
          chatEcho: view.chatEcho,
          admittedMessageId: view.admittedMessageId,
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

const NO_DISCARDED_SENDS: ReadonlySet<string> = new Set();
const noMoreHistory = () => Promise.resolve();
const noWindow = () => {};

/**
 * The Thread's full prompt list for the outline, read each time the outline
 * opens; the list from the last read shows meanwhile.
 */
function usePromptList(readPrompts: FlueClient["prompts"] | undefined) {
  const [prompts, setPrompts] =
    React.useState<ReadonlyArray<FlueConversationPrompt>>();
  const pending = React.useRef<Promise<void>>(undefined);
  const load = () => {
    if (readPrompts === undefined || pending.current !== undefined) return;
    pending.current = readPrompts()
      .then(
        (list) => setPrompts(list.prompts),
        // The outline keeps the loaded prompts; the next open reads again.
        () => undefined,
      )
      .finally(() => {
        pending.current = undefined;
      });
  };
  return { prompts, load };
}

/** The transcript, the one part of the panel that renders every frame. */
function AgentConversation({
  source,
  transcripts,
  view,
  archived,
  active,
  showProcessingIndicator,
  footer,
  optimisticCreation,
  onInitialSubmissionObserved,
  initialDispatch,
  focus,
  onFocusHandled,
  onFocusRequested,
  onReply,
  canDictate,
  readPrompts,
}: {
  readonly onReply?: TranscriptReply;
  readonly canDictate: boolean;
  /** Reads the Thread's full prompt list, for the outline. */
  readonly readPrompts?: FlueClient["prompts"];
  readonly source: AgentSource<PanelAgent>;
  readonly transcripts: ReturnType<typeof createTranscriptDerivation>;
  readonly view: TranscriptView;
  readonly archived: boolean;
  readonly active: boolean;
  readonly showProcessingIndicator: boolean;
  readonly footer: React.ReactNode;
  readonly optimisticCreation?: OptimisticThreadCreation;
  readonly onInitialSubmissionObserved?: (submissionId: string) => void;
  readonly initialDispatch?: ThreadDetailData["initialDispatch"];
  readonly focus?: TranscriptFocus;
  readonly onFocusHandled?: () => void;
  readonly onFocusRequested?: () => void;
}) {
  const observed = React.useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot,
  );
  const { agent, model: liveModel } = transcripts.derive(observed, view);
  // History opened at an older prompt shows instead of the live
  // conversation once its first page arrives, until it joins the live pages.
  const [windowTranscripts] = React.useState(createTranscriptDerivation);
  const historyWindow =
    agent.historyWindow !== undefined && agent.historyWindow.messages.length > 0
      ? agent.historyWindow
      : undefined;
  const model =
    historyWindow === undefined
      ? liveModel
      : windowTranscripts.derive(
          {
            ...agent,
            messages: historyWindow.messages,
            settlements: historyWindow.settlements,
            finalOutputs: historyWindow.finalOutputs,
            failedSends: [],
            hasMore: historyWindow.hasOlder,
          },
          {
            discardedSends: NO_DISCARDED_SENDS,
            unconfirmed: false,
            inboundMessages: undefined,
            queuedMessages: undefined,
            chatEcho: view.chatEcho,
            admittedMessageId: view.admittedMessageId,
          },
        ).model;
  const promptList = usePromptList(readPrompts);
  const initialSubmissionObserved =
    optimisticCreation?.submissionId !== undefined &&
    agent.messages.some(
      (message) =>
        message.role === "user" &&
        message.submissionId === optimisticCreation.submissionId,
    );
  const initialSubmissionId = optimisticCreation?.submissionId;
  // The first message failed to start: the transcript stays blank and the
  // card above the composer says why, until a message is sent.
  const blank =
    initialDispatch?.state === "failed" &&
    !agent.messages.some(({ role }) => role === "user");
  const reconcileInitialSubmission = (node: HTMLSpanElement | null) => {
    if (
      node === null ||
      initialSubmissionId === undefined ||
      onInitialSubmissionObserved === undefined
    )
      return;
    queueMicrotask(() => onInitialSubmissionObserved(initialSubmissionId));
  };
  const transcript = (
    <ThreadTranscript
      model={model}
      active={active}
      onReply={onReply}
      canDictate={canDictate}
      historyReady={agent.historyReady}
      {...(historyWindow === undefined
        ? {
            hasMore: agent.hasMore,
            loadingOlder: agent.loadingOlder,
            olderError: agent.olderError,
            loadOlder: agent.loadOlder,
          }
        : {
            hasMore: historyWindow.hasOlder,
            loadingOlder: historyWindow.loading === "older",
            olderError: historyWindow.error,
            loadOlder: agent.loadWindowOlder,
            historyWindow: {
              hasNewer: historyWindow.hasNewer,
              loadingNewer: historyWindow.loading === "newer",
              newerError: historyWindow.error,
              loadNewer: agent.loadWindowNewer ?? noMoreHistory,
              close: agent.closeHistoryWindow ?? noWindow,
            },
          })}
      {...(agent.openHistoryWindow === undefined || readPrompts === undefined
        ? {}
        : {
            promptOutline: {
              prompts: promptList.prompts,
              load: promptList.load,
              open: agent.openHistoryWindow,
            },
          })}
      {...(focus === undefined
        ? {}
        : { focus, onFocusHandled, onFocusRequested })}
      showProcessingIndicator={showProcessingIndicator}
      header={
        <AgentTranscriptHeader
          archived={archived}
          historyReady={agent.historyReady}
          blank={blank}
          messageCount={
            agent.messages.length +
            (optimisticCreation !== undefined && !initialSubmissionObserved
              ? 1
              : 0)
          }
        />
      }
      pinnedContent={
        optimisticCreation === undefined ||
        blank ? null : initialSubmissionObserved ? (
          <span hidden ref={reconcileInitialSubmission} />
        ) : (
          <OptimisticInitialMessage creation={optimisticCreation} />
        )
      }
      footer={footer}
    />
  );
  return transcript;
}

/**
 * Editing and deleting the viewer's messages in the agent panel: the
 * messages this tab sent that the agent has not read can change in place;
 * the composer holds an edit's own draft, so the person's unsent draft waits
 * untouched until the edit ends.
 */
function useMessageChanges({
  options,
  source,
  draftValue,
  transcript,
  working,
  setActionError,
}: {
  readonly options: MessageEditOptions | undefined;
  readonly source: AgentSource<UseFlueAgentResult>;
  readonly draftValue: Parameters<typeof useMessageEditing>[0]["draftValue"];
  readonly transcript: () => TranscriptViewModel;
  readonly working: boolean;
  readonly setActionError: React.Dispatch<
    React.SetStateAction<ThreadErrorPresentation | undefined>
  >;
}) {
  // This tab's messages the agent has not read, by the submission they
  // wait under; they can be edited and deleted in place.
  const localSubmissions = useAgentSelection(
    source,
    (agent) => agent.localSubmissions ?? NO_LOCAL_SUBMISSIONS,
    sameLocalSubmissions,
  );
  const waitingSubmission =
    options?.editQueued === undefined
      ? undefined
      : waitingSubmissionOf(localSubmissions);
  const messageDeleting = useMessageDeleting({
    options,
    source,
    transcript,
    waitingSubmission,
    working,
  });
  // Editing an earlier message: the composer holds the edit's own draft, so
  // the person's unsent draft waits untouched until the edit ends.
  const messageEditing = useMessageEditing({
    options,
    source,
    draftValue,
    transcript,
    waitingSubmission,
    remove: messageDeleting.start,
    onError: (error) =>
      setActionError((current) =>
        error !== undefined
          ? { id: "action:edit", ...error, action: "none" }
          : current?.id === "action:edit"
            ? undefined
            : current,
      ),
  });
  return { messageDeleting, messageEditing };
}

/** What an archived Thread shows in the composer's place, if anything. */
function ArchivedComposerDock({
  children,
}: {
  readonly children?: React.ReactNode;
}) {
  return children === undefined ? null : (
    <div className="agent-composer-dock" data-archived-composer="">
      {children}
    </div>
  );
}

const composerDockRef = (node: HTMLDivElement | null) =>
  node === null ? undefined : observeComposerDock(node);

export function AgentPanel({
  source: retainedSource,
  agent: renderedAgent,
  archived = false,
  showArchivedNotice = false,
  projectDeleted = false,
  orbRemoved = false,
  active = true,
  additionalPanels,
  renderHeader,
  transcriptAccess,
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
  composerModel,
  transcriptEnd,
  quickActions,
  optimisticCreation,
  initialDispatch,
  onRetryInitialDispatch,
  onInitialSubmissionObserved,
  onOpenModelRouting,
  inboundMessages,
  readOnlyNotice,
  archivedComposer,
  onAccessChanged,
  mentions,
  focus,
  onFocusHandled,
  onFocusRequested,
  messageEdit,
}: AgentPanelProps) {
  const source =
    retainedSource ?? agentValueSource(renderedAgent as PanelAgent);
  const [discardedSends, setDiscardedSends] = useThreadPresentation<
    ReadonlySet<string>
  >("discarded-sends", () => new Set());
  const retainedDraft = useThreadPresentationValue("draft", "");
  // The transcript's jump to the end, called when the person sends.
  const followOnSend = useThreadPresentationValue<(() => void) | undefined>(
    TRANSCRIPT_FOLLOW_ON_SEND,
    undefined,
  );
  const draftValue = ownerDraft ?? retainedDraft;
  // The composer's Reply, which a transcript selection quotes into.
  const composerReply = React.useRef<TranscriptReply>(undefined);
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
  const retainedThread = React.useContext(ThreadPresentationContext);
  // The reader is stable for the panel's lifetime; hand it over once mounted.
  const provideTranscriptAccess = (node: HTMLDivElement | null) => {
    if (node === null) return;
    transcriptAccess?.provide(transcripts.current);
  };
  const editOptions =
    archived || readOnlyNotice !== undefined ? undefined : messageEdit;
  const view: TranscriptView = {
    discardedSends,
    unconfirmed: admissionPending || submissionPending || sendFailed,
    inboundMessages,
    queuedMessages: editOptions?.queuedMessages,
    chatEcho,
    // A message sent from this page is commented on under Flue's id.
    admittedMessageId: retainedThread?.client.admittedMessageId,
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

  const { messageDeleting, messageEditing } = useMessageChanges({
    options: editOptions,
    source,
    draftValue,
    transcript: transcripts.current,
    working: agentActive,
    setActionError,
  });
  const isEditing = messageEditing.editing;

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
      {typeof composerNotice === "function"
        ? composerNotice((message) => void submit(message), source)
        : composerNotice}
      <InitialDispatchFailureCard
        source={source}
        initialDispatch={initialDispatch}
        onRetry={archived ? undefined : onRetryInitialDispatch}
      />
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
      ref={provideTranscriptAccess}
    >
      {renderHeader?.(transcripts.current)}
      {showArchivedNotice ? (
        <div className="archived-thread-warning" role="note">
          {projectDeleted
            ? "Archived. Its project was deleted, so this thread is read-only."
            : orbRemoved
              ? "Archived: its Orb was removed after it went unused, so this thread is read-only."
              : "Archived. Unarchive to resume or run commands."}
        </div>
      ) : null}
      <section
        className="workspace-pane agent-pane"
        aria-label="Agent chat"
        hidden={!active}
      >
        <MessageEditContext value={messageEditing.context}>
          <AgentConversation
            source={source}
            transcripts={transcripts}
            readPrompts={retainedThread?.client.prompts}
            view={view}
            archived={archived}
            active={active}
            showProcessingIndicator={!archived && statusMessage === undefined}
            footer={
              archived ? (
                errorCard
              ) : (
                <AgentTranscriptFooter
                  statusMessage={statusMessage}
                  idleEnd={
                    agentActive || statusMessage !== undefined
                      ? undefined
                      : transcriptEnd
                  }
                />
              )
            }
            optimisticCreation={optimisticCreation}
            onInitialSubmissionObserved={onInitialSubmissionObserved}
            initialDispatch={initialDispatch}
            focus={focus}
            onFocusHandled={onFocusHandled}
            onFocusRequested={onFocusRequested}
            onReply={
              archived || readOnlyNotice !== undefined
                ? undefined
                : (quote, dictate) => composerReply.current?.(quote, dictate)
            }
            canDictate={dictationAvailable}
          />
        </MessageEditContext>

        {archived ? (
          <ArchivedComposerDock>{archivedComposer}</ArchivedComposerDock>
        ) : readOnlyNotice !== undefined ? (
          <div className="agent-composer-dock" ref={composerDockRef}>
            {readOnlyNotice}
          </div>
        ) : (
          <AgentComposer
            editing={messageEditing.composer}
            focusRef={messageEditing.focusRef}
            agentActive={agentActive}
            quickActions={
              quickActions === undefined ||
              statusMessage !== undefined ? null : (
                <ComposerQuickActions
                  source={source}
                  thread={quickActions.thread}
                  draft={draftValue}
                  attaching={images.length > 0}
                  onReply={(reply) => void submit(reply)}
                />
              )
            }
            stopAvailable={!isEditing && stopAvailable}
            dictationAvailable={dictationAvailable}
            draftValue={isEditing ? messageEditing.draft : draftValue}
            draftLocked={
              isEditing ? messageEdit?.pending === true : draftLocked
            }
            replyRef={composerReply}
            images={isEditing ? [] : images}
            dockRef={composerDockRef}
            errorCard={errorCard}
            modelControl={composerModel}
            mentions={mentions}
            onAbort={() => void stop()}
            onAddImages={(files) => void addImages(files)}
            onRemoveImage={(image) => {
              setImages(imageCollection.remove(image.id));
            }}
            onSubmit={(submittedDraft) => {
              followOnSend.get()?.();
              if (isEditing) void messageEditing.submit(submittedDraft);
              else
                void submit(submittedDraft).then(() => {
                  // A message sent while the agent works waits in its queue.
                  if (agentActive) editOptions?.onQueueChanged?.();
                });
            }}
            onTakeScreenshot={() => void takeScreenshot()}
            ref={composerLifetimeRef}
          />
        )}
      </section>
      {messageDeleting.dialog}
      {additionalPanels}
    </div>
  );
}
