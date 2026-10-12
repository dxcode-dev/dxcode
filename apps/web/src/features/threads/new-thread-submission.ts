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
import type { RefObject } from "react";
import {
  deliveredImages,
  disposeImages,
  type PendingImage,
  type PendingImageCollection,
} from "./image-attachments.js";
import { reasoningModeId } from "./new-thread-modal-utils.js";
import type { CreateThreadMutationInput } from "./thread-mutations.js";
import type { ThreadSessionRegistry } from "./thread-session-registry.js";

export interface InitialThreadCreationAttempt {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly profile: ModeId;
  readonly model?: string;
  readonly effort?: ClaudeCodeEffort;
  readonly runnerProfileId?: RunnerProfileId;
  readonly body: string;
  readonly attachmentIds: ReadonlyArray<string>;
}

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
  initialCreationAttempt,
}: {
  readonly submittedPrompt: string;
  readonly effectiveProjectId: ProjectId | "";
  readonly profile: ModeId;
  readonly model: string | undefined;
  /** Claude Code effort, sent only with a Claude Code model. */
  readonly effort?: ClaudeCodeEffort;
  readonly runnerProfileId?: RunnerProfileId;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly imageCollection: PendingImageCollection;
  readonly setImages: (images: ReadonlyArray<PendingImage>) => void;
  readonly registry: ThreadSessionRegistry;
  readonly create: (input: CreateThreadMutationInput) => Promise<{
    readonly initialSubmission?: { readonly submissionId: string };
  }>;
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly draftStore: { readonly clear: () => void };
  readonly onAccepted: () => void;
  readonly onAcceptedNavigationFailure: (threadId: ThreadId) => void;
  /** False once the composer is gone, e.g. the user went Back mid-create. */
  readonly composerOpen: () => boolean;
  readonly initialCreationAttempt: RefObject<
    InitialThreadCreationAttempt | undefined
  >;
}) {
  let stagedImages: ReadonlyArray<PendingImage> | undefined;
  let pendingThreadId: ThreadId | undefined;
  try {
    const project = projects.find(({ id }) => id === effectiveProjectId);
    if (effectiveProjectId !== "" && project === undefined)
      throw new Error("Select a valid project.");
    await imageCollection.settle();
    stagedImages = imageCollection.take();
    const body = submittedPrompt.trim();
    const attachmentIds = stagedImages.map(({ id }) => id);
    const selectedProfile = reasoningModeId(profile);
    // Effort belongs to Claude Code models only; other selections have none,
    // so a recovered attempt without one still matches.
    const claudeEffort =
      model !== undefined && isClaudeCodeModel(model) ? effort : undefined;
    const previousAttempt = initialCreationAttempt.current;
    // A retry of the same request reuses its Thread, so a creation whose
    // response was lost is not created twice.
    const threadId =
      previousAttempt !== undefined &&
      previousAttempt.projectId === project?.id &&
      previousAttempt.profile === selectedProfile &&
      previousAttempt.model === model &&
      previousAttempt.effort === claudeEffort &&
      previousAttempt.runnerProfileId === runnerProfileId &&
      previousAttempt.body === body &&
      previousAttempt.attachmentIds.length === attachmentIds.length &&
      previousAttempt.attachmentIds.every(
        (id, index) => id === attachmentIds[index],
      )
        ? previousAttempt.threadId
        : newThreadId();
    initialCreationAttempt.current = {
      threadId,
      projectId: project?.id,
      profile: selectedProfile,
      model,
      ...(claudeEffort === undefined ? {} : { effort: claudeEffort }),
      runnerProfileId,
      body,
      attachmentIds,
    };
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
    const response = await create({
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
        body,
        attachments: deliveredImages(stagedImages),
      },
    });
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
    if (pendingThreadId !== undefined) registry.failCreation(pendingThreadId);
    // Nothing was admitted: the composer keeps the prompt and its images,
    // or, when it is gone, the images are released; the draft text stays.
    if (stagedImages !== undefined) {
      if (composerOpen()) setImages(imageCollection.restore(stagedImages));
      else disposeImages(stagedImages);
    }
    throw new Error(
      cause instanceof Error
        ? cause.message
        : "The thread could not be started.",
      { cause },
    );
  }
}
