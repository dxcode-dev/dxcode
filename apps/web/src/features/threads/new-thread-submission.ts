import type { ProjectData } from "@dx/api";
import {
  type ClaudeCodeEffort,
  generateThreadTitle,
  isClaudeCodeModel,
  type ModeId,
  type ModelId,
  newThreadId,
  type ProjectId,
  type RunnerProfileId,
  type ThreadId,
} from "@dx/domain";
import type { useNavigate } from "@tanstack/react-router";
import {
  messageWithAttachments,
  type PendingAttachment,
  type PendingAttachmentCollection,
} from "./image-attachments.js";
import type {
  InitialThreadCreationAttempt,
  NewThreadDraftStore,
} from "./new-thread-draft-store.js";
import { reasoningModeId } from "./new-thread-modal-utils.js";
import type { CreateThreadMutationInput } from "./thread-mutations.js";
import type { ThreadSessionRegistry } from "./thread-session-registry.js";

/** After this long the composer says the Thread is still being created. */
export const NEW_THREAD_STALL_AFTER_MS = 15_000;

const sameRequest = (
  previous: InitialThreadCreationAttempt | undefined,
  next: Omit<InitialThreadCreationAttempt, "threadId">,
): previous is InitialThreadCreationAttempt =>
  previous !== undefined &&
  previous.projectId === next.projectId &&
  previous.profile === next.profile &&
  previous.model === next.model &&
  previous.effort === next.effort &&
  previous.runnerProfileId === next.runnerProfileId &&
  previous.body === next.body &&
  previous.attachmentIds.length === next.attachmentIds.length &&
  previous.attachmentIds.every((id, index) => id === next.attachmentIds[index]);

/** `fetch` rejects with a TypeError when no response arrived. */
const lostResponse = (cause: unknown) => cause instanceof TypeError;

/**
 * Creates the Thread and admits its first message on the server, then opens
 * it. The composer stays up, showing that the Thread is being created, until
 * Core has persisted the Thread and Flue has admitted the message; from then
 * on the run belongs to the server, whether or not this browser stays open.
 */
export async function submitNewThread({
  submittedPrompt,
  effectiveProjectId,
  profile,
  model,
  effort,
  runnerProfileId,
  projects,
  imageCollection,
  setImages,
  registry,
  create,
  navigate,
  draftStore,
  onAccepted,
  onAcceptedNavigationFailure,
  composerOpen,
}: {
  readonly submittedPrompt: string;
  readonly effectiveProjectId: ProjectId | "";
  readonly profile: ModeId;
  readonly model: string | undefined;
  /** Claude Code effort, sent only with a Claude Code model. */
  readonly effort?: ClaudeCodeEffort;
  readonly runnerProfileId?: RunnerProfileId;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly imageCollection: PendingAttachmentCollection;
  readonly setImages: (images: ReadonlyArray<PendingAttachment>) => void;
  readonly registry: ThreadSessionRegistry;
  readonly create: (input: CreateThreadMutationInput) => Promise<{
    readonly initialSubmission?: { readonly submissionId: string };
  }>;
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly draftStore: Pick<
    NewThreadDraftStore,
    "clear" | "getCreation" | "setCreation"
  >;
  readonly onAccepted: () => void;
  readonly onAcceptedNavigationFailure: (threadId: ThreadId) => void;
  /** False once the composer is gone, e.g. the user closed it mid-create. */
  readonly composerOpen: () => boolean;
}) {
  let stagedImages: ReadonlyArray<PendingAttachment> | undefined;
  let pendingThreadId: ThreadId | undefined;
  const { attempt: previousAttempt } = draftStore.getCreation();
  draftStore.setCreation({
    ...(previousAttempt === undefined ? {} : { attempt: previousAttempt }),
    sending: true,
    stalled: false,
  });
  try {
    const project = projects.find(({ id }) => id === effectiveProjectId);
    if (effectiveProjectId !== "" && project === undefined)
      throw new Error("Select a valid project.");
    await imageCollection.settle();
    stagedImages = imageCollection.take();
    const body = submittedPrompt.trim();
    let sentBody: string;
    try {
      sentBody = await messageWithAttachments(body, stagedImages);
    } catch (cause) {
      // An upload failed: keep the files so the person can remove it.
      setImages(imageCollection.restore(stagedImages));
      stagedImages = undefined;
      throw cause;
    }
    // The composer stays unchanged, files included, until admission.
    const attachmentIds = stagedImages.map(({ id }) => id);
    const selectedProfile = reasoningModeId(profile);
    // Effort belongs to Claude Code models only; other selections have none,
    // so a recovered attempt without one still matches.
    const claudeEffort =
      model !== undefined && isClaudeCodeModel(model) ? effort : undefined;
    const request = {
      projectId: project?.id,
      profile: selectedProfile,
      model,
      ...(claudeEffort === undefined ? {} : { effort: claudeEffort }),
      runnerProfileId,
      body,
      attachmentIds,
    };
    // Resending the same request reuses its Thread, even from a composer
    // opened since, so a creation whose response was lost is not made twice.
    const attempt: InitialThreadCreationAttempt = {
      ...request,
      threadId: sameRequest(previousAttempt, request)
        ? previousAttempt.threadId
        : newThreadId(),
    };
    const threadId = attempt.threadId;
    const title = generateThreadTitle(submittedPrompt);
    registry.beginCreation({
      id: threadId,
      project,
      title,
      profile: selectedProfile,
      model,
      ...(claudeEffort === undefined ? {} : { effort: claudeEffort }),
      runnerProfileId,
      body,
      images: stagedImages,
      startedAt: Date.now(),
    });
    pendingThreadId = threadId;
    const input = {
      project,
      title,
      selection:
        model === undefined
          ? { kind: "mode", profileId: "default", mode: selectedProfile }
          : {
              kind: "model",
              model: model as ModelId,
              ...(claudeEffort === undefined ? {} : { thinking: claudeEffort }),
            },
      ...(runnerProfileId === undefined ? {} : { runnerProfileId }),
      threadId,
      initialMessage: {
        body: sentBody,
        attachments: [],
      },
    } satisfies CreateThreadMutationInput;
    // The same Thread ID makes every send idempotent: Core answers a resend
    // with the receipt of a message it already admitted.
    let resentAfterLostResponse = false;
    let response: Awaited<ReturnType<typeof create>> | undefined;
    while (response === undefined) {
      const controller = new AbortController();
      draftStore.setCreation({
        attempt,
        sending: true,
        stalled: false,
        retry: () => controller.abort(),
      });
      const stall = setTimeout(
        () =>
          draftStore.setCreation({
            ...draftStore.getCreation(),
            stalled: true,
          }),
        NEW_THREAD_STALL_AFTER_MS,
      );
      try {
        response = await create({ ...input, signal: controller.signal });
      } catch (cause) {
        // The person asked to send it again.
        if (controller.signal.aborted) continue;
        if (lostResponse(cause) && !resentAfterLostResponse) {
          resentAfterLostResponse = true;
          continue;
        }
        if (lostResponse(cause))
          throw new Error(
            "dx could not be reached. Send again to retry; it will not start a second Thread.",
            { cause },
          );
        throw cause;
      } finally {
        clearTimeout(stall);
      }
    }
    const submissionId = response.initialSubmission?.submissionId;
    if (submissionId === undefined)
      throw new Error("The initial message receipt was missing.");
    // The registry now owns the staged images until Flue shows the message.
    registry.acceptCreation(threadId, submissionId);
    pendingThreadId = undefined;
    stagedImages = undefined;
    setImages([]);
    draftStore.clear();
    // The user already left; the Thread waits for them in the sidebar.
    if (!composerOpen()) return;
    try {
      await navigate({ to: "/threads/$threadId", params: { threadId } });
    } catch (cause) {
      onAcceptedNavigationFailure(threadId);
      throw new Error("Thread was created, but could not be opened.", {
        cause,
      });
    }
    onAccepted();
  } catch (cause) {
    // The request is kept: sending it again reuses its Thread.
    const { attempt } = draftStore.getCreation();
    draftStore.setCreation({
      ...(attempt === undefined ? {} : { attempt }),
      sending: false,
      stalled: false,
    });
    if (pendingThreadId !== undefined) registry.failCreation(pendingThreadId);
    // Nothing was admitted: the draft keeps the prompt and its files, so
    // they are there when the composer opens again.
    if (stagedImages !== undefined)
      setImages(imageCollection.restore(stagedImages));
    throw new Error(
      cause instanceof Error
        ? cause.message
        : "The thread could not be started.",
      { cause },
    );
  }
}
