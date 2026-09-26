import type { ThreadAgentInitializationData } from "@dx/api";
import {
  type FailedSend,
  isInputTooLargeError,
  type UseFlueAgentResult,
} from "@flue/react";
import { ArrowUp, Square } from "lucide-react";
import * as React from "react";
import { Badge } from "../../shared/ui/badge.js";
import { Button } from "../../shared/ui/button.js";
import { useDictation } from "./dictation/use-dictation.js";
import {
  captureScreenshot,
  createPendingImageCollection,
  deliveredImages,
  disposeImages,
  type PendingImage,
  type PendingImageCollection,
} from "./image-attachments.js";
import { AttachmentMenu, ImagePreviews } from "./image-attachments-ui.js";
import { ProcessingIndicator } from "./processing-indicator.js";
import type {
  OptimisticThreadCreation,
  PendingSubmissionControl,
  PendingSubmissionImageRetention,
} from "./thread-session-registry.js";
import {
  ThreadTranscript,
  type TranscriptRowFailure,
} from "./thread-transcript.js";
import { TranscriptMarkdown } from "./transcript-markdown.js";
import { deriveTranscriptViewModel } from "./transcript-view-model.js";

const emptyTranscript = deriveTranscriptViewModel({
  messages: [],
  settlements: [],
});

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
        {creation.body ? (
          <TranscriptMarkdown>{creation.body}</TranscriptMarkdown>
        ) : null}
        <ImagePreviews images={creation.images} onRemove={() => {}} disabled />
      </div>
    </article>
  );
}

export function PendingAgentPanel({
  creation,
}: {
  readonly creation: OptimisticThreadCreation;
}) {
  return (
    <div className="agent-panel-stack">
      <section className="workspace-pane agent-pane" aria-label="Agent chat">
        <ThreadTranscript
          model={emptyTranscript}
          historyReady={false}
          showProcessingIndicator={false}
          pinnedContent={<OptimisticInitialMessage creation={creation} />}
          footer={
            <ProcessingIndicator
              accessibleLabel="Starting thread…"
              className="initial-thread-status"
              label="Starting thread…"
            />
          }
        />
        <div className="agent-composer-dock">
          <form className="agent-composer">
            <textarea
              aria-label="Message"
              data-command-target="thread-composer"
              disabled
              placeholder="Message"
              value=""
              readOnly
            />
            <div className="composer-actions">
              <span className="composer-spacer" />
              <Button
                type="submit"
                size="icon-sm"
                className="composer-submit"
                aria-label="Send message"
                disabled
              >
                <ArrowUp />
              </Button>
            </div>
          </form>
        </div>
      </section>
    </div>
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
      {!historyReady && messageCount === 0 ? (
        <div className="transcript-loading">
          <span className="tool-spinner" /> Loading conversation…
        </div>
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
  actionError,
  agentError,
  failedSendCount,
  statusMessage,
}: {
  readonly actionError?: string;
  readonly agentError?: Error;
  readonly failedSendCount: number;
  readonly statusMessage?: string;
}) {
  return (
    <>
      {agentError && failedSendCount === 0 ? (
        <div className="notice error-notice">{agentError.message}</div>
      ) : null}
      {actionError ? (
        <div className="notice error-notice">{actionError}</div>
      ) : null}
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

function AgentComposer({
  agentActive,
  stopAvailable,
  dictationAvailable,
  draft,
  draftLocked,
  images,
  onAbort,
  onAddImages,
  onChangeDraft,
  onRemoveImage,
  onSubmit,
  onTakeScreenshot,
  ref,
}: {
  readonly agentActive: boolean;
  readonly stopAvailable: boolean;
  readonly dictationAvailable: boolean;
  readonly draft: string;
  readonly draftLocked: boolean;
  readonly images: ReadonlyArray<PendingImage>;
  readonly onAbort: () => void;
  readonly onAddImages: (files: ReadonlyArray<File>) => void;
  readonly onChangeDraft: (draft: string) => void;
  readonly onRemoveImage: (image: PendingImage) => void;
  readonly onSubmit: (draft: string) => void;
  readonly onTakeScreenshot: () => void;
  readonly ref: React.RefCallback<HTMLFormElement>;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation({
    enabled: dictationAvailable,
    locked: draftLocked,
    onChange: onChangeDraft,
    onSend: onSubmit,
    textareaRef,
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!dictation.interceptSubmit()) onSubmit(draft);
  };
  return (
    <div className="agent-composer-dock">
      <form className="agent-composer" onSubmit={submit} ref={ref}>
        <ImagePreviews
          images={images}
          onRemove={onRemoveImage}
          disabled={draftLocked}
        />
        <textarea
          ref={textareaRef}
          aria-label="Message"
          data-command-target="thread-composer"
          disabled={draftLocked}
          placeholder="Message"
          value={draft}
          onChange={(event) => onChangeDraft(event.target.value)}
          onKeyDown={(event) => {
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
            disabled={draftLocked}
            onFiles={onAddImages}
            onScreenshot={onTakeScreenshot}
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

function useAgentSubmission({
  agent,
  draft,
  setDraft,
  images,
  setImages,
  imageCollection,
  submissionImageRetention,
  submissionPending,
  submissionControl,
  onSubmissionPendingChange,
}: {
  readonly agent: UseFlueAgentResult;
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly images: ReadonlyArray<PendingImage>;
  readonly setImages: (images: ReadonlyArray<PendingImage>) => void;
  readonly imageCollection: PendingImageCollection;
  readonly submissionImageRetention?: PendingSubmissionImageRetention;
  readonly submissionPending: boolean;
  readonly submissionControl: PendingSubmissionControl;
  readonly onSubmissionPendingChange?: (pending: boolean) => void;
}) {
  const [admissionPending, setAdmissionPending] = React.useState(false);
  const submitInFlight = React.useRef(false);
  const submitGeneration = React.useRef(0);
  const composerMounted = React.useRef(false);
  const [actionError, setActionError] = React.useState<string>();
  const finishAdmission = () => {
    submitInFlight.current = false;
    submissionControl.stopRequested = false;
    onSubmissionPendingChange?.(false);
    setAdmissionPending(false);
  };
  const stopAgent = async () => {
    try {
      await agent.abort();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The thread could not be stopped.",
      );
    }
  };
  const stop = async () => {
    submitGeneration.current += 1;
    if (submitInFlight.current || submissionPending)
      submissionControl.stopRequested = true;
    await stopAgent();
  };
  const submit = async (submittedDraft = draft) => {
    const message = submittedDraft.trim();
    if (
      submitInFlight.current ||
      submissionPending ||
      (!message && images.length === 0)
    )
      return;
    submitInFlight.current = true;
    submissionControl.stopRequested = false;
    onSubmissionPendingChange?.(true);
    const generation = ++submitGeneration.current;
    setAdmissionPending(true);
    const runAdmission = async () => {
      let submittedImages: ReadonlyArray<PendingImage> | undefined;
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
        const attachments = deliveredImages(submittedImages);
        await agent.sendMessage(message, { images: attachments });
        if (submissionControl.stopRequested) await stopAgent();
        if (
          !imagesRetained ||
          submissionImageRetention?.complete(submittedImages)
        )
          disposeImages(submittedImages);
      } catch (cause) {
        if (
          submittedImages !== undefined &&
          isInputTooLargeError(cause) &&
          composerMounted.current
        ) {
          if (imagesRetained)
            submissionImageRetention?.complete(submittedImages);
          setDraft(message);
          setImages(imageCollection.restore(submittedImages));
        } else if (submittedImages !== undefined) {
          if (imagesRetained)
            submissionImageRetention?.complete(submittedImages);
          disposeImages(submittedImages);
        }
        if (!composerMounted.current) return;
        setActionError(
          cause instanceof Error ? cause.message : "Message could not be sent.",
        );
      }
    };
    return runAdmission().finally(finishAdmission);
  };
  return {
    actionError,
    composerMounted,
    admissionPending,
    setActionError,
    stop,
    submit,
  };
}

export function AgentPanel({
  agent,
  agentInitialization,
  archived = false,
  showArchivedNotice = false,
  active = true,
  additionalPanels,
  renderHeader,
  draft: controlledDraft,
  onDraftChange,
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
}: {
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
  readonly draft?: string;
  readonly onDraftChange?: (draft: string) => void;
  readonly images?: ReadonlyArray<PendingImage>;
  readonly onImagesChange?: (images: ReadonlyArray<PendingImage>) => void;
  readonly imageCollection?: PendingImageCollection;
  readonly submissionImageRetention?: PendingSubmissionImageRetention;
  readonly submissionPending?: boolean;
  readonly submissionControl?: PendingSubmissionControl;
  readonly onSubmissionPendingChange?: (pending: boolean) => void;
  readonly dictationAvailable?: boolean;
  readonly workspaceReady?: boolean;
  readonly workspaceStatus?: string;
  readonly optimisticCreation?: OptimisticThreadCreation;
  readonly onInitialSubmissionObserved?: (submissionId: string) => void;
}) {
  const [localDraft, setLocalDraft] = React.useState("");
  const draft = controlledDraft ?? localDraft;
  const setDraft = onDraftChange ?? setLocalDraft;
  const [localImages, setLocalImages] = React.useState<
    ReadonlyArray<PendingImage>
  >([]);
  const images = controlledImages ?? localImages;
  const setImages = onImagesChange ?? setLocalImages;
  const [imageCollection] = React.useState(
    () => retainedImageCollection ?? createPendingImageCollection(),
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
    setActionError,
    stop,
    submit,
  } = useAgentSubmission({
    agent,
    draft,
    setDraft,
    images,
    setImages,
    imageCollection,
    submissionImageRetention,
    submissionPending,
    submissionControl,
    onSubmissionPendingChange,
  });
  const agentActive =
    agent.status === "submitted" || agent.status === "streaming";
  const draftLocked = admissionPending || submissionPending;
  const stopAvailable = agentActive || admissionPending;
  const model = deriveTranscriptViewModel({
    messages: agent.messages,
    settlements: agent.settlements,
    finalOutputs: agent.finalOutputs,
  });
  const statusMessage =
    workspaceStatus ??
    (agent.status === "submitted" && !workspaceReady
      ? "Preparing workspace…"
      : undefined);
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

  const retry = (failedSend: FailedSend) => {
    setActionError(undefined);
    void agent.retrySend(failedSend.id).catch((cause: unknown) => {
      setActionError(
        cause instanceof Error ? cause.message : "Message could not be sent.",
      );
    });
  };

  const addImages = async (files: ReadonlyArray<File>) => {
    if (files.length === 0) return;
    setActionError(undefined);
    try {
      setImages(await imageCollection.addFiles(files));
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "Image could not be attached.",
      );
    }
  };

  const takeScreenshot = async () => {
    setActionError(undefined);
    try {
      setImages(await imageCollection.addGenerated(captureScreenshot));
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The screenshot could not be captured.",
      );
    }
  };

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

  const failures = archived
    ? new Map<string, TranscriptRowFailure>()
    : new Map<string, TranscriptRowFailure>(
        agent.failedSends.map((failedSend) => [
          failedSend.id,
          {
            message: failedSend.error.message,
            retry: () => retry(failedSend),
          },
        ]),
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
          failures={failures}
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
            archived ? null : (
              <AgentTranscriptFooter
                actionError={actionError}
                agentError={agent.error}
                failedSendCount={agent.failedSends.length}
                statusMessage={statusMessage}
              />
            )
          }
        />

        {archived ? null : (
          <AgentComposer
            agentActive={agentActive}
            stopAvailable={stopAvailable}
            dictationAvailable={dictationAvailable}
            draft={draft}
            draftLocked={draftLocked}
            images={images}
            onAbort={() => void stop()}
            onAddImages={(files) => void addImages(files)}
            onChangeDraft={setDraft}
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
