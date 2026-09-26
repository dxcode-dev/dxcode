import type { ProjectData } from "@dx/api";
import {
  generateThreadTitle,
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
  type PendingImage,
  type PendingImageCollection,
} from "./image-attachments.js";
import { reasoningModeId } from "./new-thread-modal-utils.js";
import {
  type CreateThreadMutationInput,
  optimisticThreadData,
} from "./thread-mutations.js";
import type { ThreadSessionRegistry } from "./thread-session-registry.js";

export interface InitialThreadCreationAttempt {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly profile: ModeId;
  readonly model?: string;
  readonly runnerProfileId?: RunnerProfileId;
  readonly body: string;
  readonly attachmentIds: ReadonlyArray<string>;
}

export async function submitNewThread({
  submittedPrompt,
  effectiveProjectId,
  profile,
  model,
  runnerProfileId,
  projects,
  imageCollection,
  setImages,
  registry,
  create,
  navigate,
  routeScoped,
  returnPath,
  draftStore,
  onAccepted,
  onAcceptedNavigationFailure,
  setOptimisticThreadId,
  initialCreationAttempt,
}: {
  readonly submittedPrompt: string;
  readonly effectiveProjectId: ProjectId | "";
  readonly profile: ModeId;
  readonly model: string | undefined;
  readonly runnerProfileId?: RunnerProfileId;
  readonly projects: ReadonlyArray<ProjectData>;
  readonly imageCollection: PendingImageCollection;
  readonly setImages: (images: ReadonlyArray<PendingImage>) => void;
  readonly registry: ThreadSessionRegistry;
  readonly create: (input: CreateThreadMutationInput) => Promise<{
    readonly initialSubmission?: { readonly submissionId: string };
  }>;
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly routeScoped: boolean;
  readonly returnPath: string;
  readonly draftStore: { readonly clear: () => void };
  readonly onAccepted: () => void;
  readonly onAcceptedNavigationFailure: (threadId: ThreadId) => void;
  readonly setOptimisticThreadId: (threadId?: ThreadId) => void;
  readonly initialCreationAttempt: RefObject<
    InitialThreadCreationAttempt | undefined
  >;
}) {
  let stagedImages: ReadonlyArray<PendingImage> | undefined;
  let pendingThreadId: ThreadId | undefined;
  let navigationSucceeded = false;
  let creationAccepted = false;
  try {
    const project = projects.find(({ id }) => id === effectiveProjectId);
    if (effectiveProjectId !== "" && project === undefined)
      throw new Error("Select a valid project.");
    await imageCollection.settle();
    stagedImages = imageCollection.take();
    setImages([]);
    const body = submittedPrompt.trim();
    const attachmentIds = stagedImages.map(({ id }) => id);
    const selectedProfile = reasoningModeId(profile);
    const previousAttempt = initialCreationAttempt.current;
    const threadId =
      previousAttempt !== undefined &&
      previousAttempt.projectId === project?.id &&
      previousAttempt.profile === selectedProfile &&
      previousAttempt.model === model &&
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
      runnerProfileId,
      body,
      attachmentIds,
    };
    const title = generateThreadTitle(submittedPrompt);
    const creation = {
      id: threadId,
      project,
      title,
      profile: selectedProfile,
      model,
      runnerProfileId,
      body,
      images: stagedImages,
    };
    registry.beginCreation(creation);
    pendingThreadId = threadId;
    const responseOutcome = create({
      project,
      title,
      selection:
        model === undefined
          ? { kind: "mode", profileId: "default", mode: selectedProfile }
          : { kind: "model", model: model as ModelId },
      ...(runnerProfileId === undefined ? {} : { runnerProfileId }),
      threadId,
      ...(project === undefined
        ? {}
        : {
            optimisticThread: optimisticThreadData(threadId, project.id, title),
          }),
      initialMessage: {
        body,
        attachments: deliveredImages(stagedImages),
      },
    }).then(
      (response) => ({ response }) as const,
      (error: unknown) => ({ error }) as const,
    );
    setOptimisticThreadId(threadId);
    let navigationError: unknown;
    try {
      await navigate({
        to: "/threads/$threadId",
        params: { threadId },
      });
      navigationSucceeded = true;
    } catch (cause) {
      navigationError = cause;
    }
    const outcome = await responseOutcome;
    if ("error" in outcome) throw outcome.error;
    const response = outcome.response;
    const submissionId = response.initialSubmission?.submissionId;
    if (submissionId === undefined)
      throw new Error("The initial message receipt was missing.");
    registry.acceptCreation(threadId, submissionId);
    creationAccepted = true;
    stagedImages = undefined;
    draftStore.clear();
    if (navigationError !== undefined) {
      onAcceptedNavigationFailure(threadId);
      throw new Error("Thread was created, but could not be opened.", {
        cause: navigationError,
      });
    }
    onAccepted();
  } catch (cause) {
    const message =
      cause instanceof Error
        ? cause.message
        : "The thread could not be started.";
    const failed =
      pendingThreadId === undefined || creationAccepted
        ? undefined
        : registry.failCreation(pendingThreadId);
    const recoverable =
      failed ??
      (stagedImages === undefined ||
      initialCreationAttempt.current === undefined
        ? undefined
        : {
            id: initialCreationAttempt.current.threadId,
            project:
              initialCreationAttempt.current.projectId === undefined
                ? undefined
                : (projects.find(
                    ({ id }) =>
                      id === initialCreationAttempt.current?.projectId,
                  ) ?? projects[0]),
            title: generateThreadTitle(submittedPrompt),
            profile: initialCreationAttempt.current.profile,
            model: initialCreationAttempt.current.model,
            runnerProfileId: initialCreationAttempt.current.runnerProfileId,
            body: initialCreationAttempt.current.body,
            images: stagedImages,
          });
    if (recoverable !== undefined) {
      stagedImages = undefined;
      if (routeScoped && navigationSucceeded) {
        registry.retainFailedCreation({ ...recoverable, error: message });
        await navigate({
          to: "/new",
          search: { project: recoverable.project?.id },
          replace: true,
        });
      } else {
        setImages(imageCollection.restore(recoverable.images));
        if (!routeScoped) await navigate({ to: returnPath });
      }
    }
    setOptimisticThreadId(undefined);
    throw new Error(message, { cause });
  }
}
