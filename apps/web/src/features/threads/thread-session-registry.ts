import type { ProjectData, ThreadAgentInitializationData } from "@dx/api";
import type {
  ModeId,
  ProjectId,
  RunnerProfileId,
  ThreadId,
  ThreadTitle,
  UserId,
} from "@dx/domain";
import { createFlueAgentSession, type FlueAgentSession } from "@flue/react";
import { createFlueClient, type FlueClient } from "@flue/sdk";
import { type QueryClient, QueryObserver } from "@tanstack/react-query";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";
import { projectQueryOptions } from "../projects/project-queries.js";
import { DictationRecoverySession } from "./dictation/dictation-session.js";
import { existingAgentUid } from "./existing-agent-uid.js";
import {
  createPendingImageCollection,
  disposeImages,
  type PendingImage,
} from "./image-attachments.js";
import { threadQueryOptions } from "./thread-queries.js";

export const createThreadAgentClient = (
  agentUrl: string,
  initialData: ThreadAgentInitializationData,
): FlueClient => {
  const client = createFlueClient({ url: agentUrl, fetch: sameOriginFetch });
  const send = client.send.bind(client);
  let initializing = true;
  client.send = async (options) => {
    if (!initializing) return send(options);
    try {
      const receipt = await send({
        ...options,
        uid: null,
        initialData,
      });
      initializing = false;
      return receipt;
    } catch (cause) {
      const uid = existingAgentUid(cause);
      if (uid === undefined) throw cause;
      const receipt = await send({ ...options, uid });
      initializing = false;
      return receipt;
    }
  };
  return client;
};

export const isAuthorizationError = (error: unknown): boolean =>
  error instanceof Error &&
  "status" in error &&
  (error.status === 401 || error.status === 403 || error.status === 404);

export interface RetainedThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly client: FlueClient;
  readonly session: FlueAgentSession;
  readonly dictation: DictationRecoverySession;
  readonly presentation: Map<string, unknown>;
  readonly presentationListeners: Set<() => void>;
  readonly images: ReturnType<typeof createPendingImageCollection>;
  pendingSubmissionImages?: ReadonlyArray<PendingImage>;
  disposed: boolean;
}

export interface PendingSubmissionImageRetention {
  readonly retain: (images: ReadonlyArray<PendingImage>) => boolean;
  readonly complete: (images: ReadonlyArray<PendingImage>) => boolean;
  readonly restore: (
    images: ReadonlyArray<PendingImage>,
    draft: string,
  ) => boolean;
}

export interface PendingSubmissionControl {
  stopRequested: boolean;
}

export interface OptimisticThreadCreation {
  readonly id: ThreadId;
  readonly project?: ProjectData;
  readonly title: ThreadTitle;
  readonly profile: ModeId;
  readonly model?: string;
  readonly runnerProfileId?: RunnerProfileId;
  readonly body: string;
  readonly images: ReadonlyArray<PendingImage>;
  readonly submissionId?: string;
}

export interface FailedThreadCreation extends OptimisticThreadCreation {
  readonly error: string;
}

export const retainSubmissionImages = (
  entry: RetainedThread,
  setPending: (pending: boolean) => void,
): PendingSubmissionImageRetention => ({
  retain: (images) => {
    if (entry.disposed || entry.pendingSubmissionImages !== undefined)
      return false;
    entry.pendingSubmissionImages = images;
    setPending(true);
    return true;
  },
  complete: (images) => {
    if (entry.disposed || entry.pendingSubmissionImages !== images)
      return false;
    entry.pendingSubmissionImages = undefined;
    setPending(false);
    return true;
  },
  restore: (images, draft) => {
    if (entry.disposed || entry.pendingSubmissionImages !== images)
      return false;
    entry.pendingSubmissionImages = undefined;
    const currentDraft = entry.presentation.get("draft");
    const currentImages = entry.presentation.get("pending-images");
    if (
      currentDraft === "" &&
      Array.isArray(currentImages) &&
      currentImages.length === 0
    ) {
      entry.images.restore(images);
      entry.presentation.set("draft", draft);
      entry.presentation.set("pending-images", images);
    } else {
      disposeImages(images);
    }
    setPending(false);
    return true;
  },
});

/** Stores capabilities, never Flue history or dx HTTP entities. Selection is a
 * committed route activation, not a preload, hover, render or query refresh. */
export class ThreadSessionRegistry {
  private readonly entries = new Map<ThreadId, RetainedThread>();
  private readonly releases = new Map<ThreadId, () => void>();
  private readonly creations = new Map<ThreadId, OptimisticThreadCreation>();
  private readonly creationListeners = new Set<() => void>();
  private failedCreation: FailedThreadCreation | undefined;
  private active: { entry: RetainedThread; generation: number } | undefined;
  private generation = 0;

  constructor(
    private readonly queryClient: QueryClient,
    private readonly userId: UserId,
  ) {}

  readonly subscribeCreations = (listener: () => void) => {
    this.creationListeners.add(listener);
    return () => this.creationListeners.delete(listener);
  };

  creation(id: ThreadId): OptimisticThreadCreation | undefined {
    return this.creations.get(id);
  }

  beginCreation(creation: OptimisticThreadCreation): void {
    const previous = this.creations.get(creation.id);
    if (previous !== undefined && previous !== creation)
      disposeImages(previous.images);
    this.creations.delete(creation.id);
    this.creations.set(creation.id, creation);
    while (this.creations.size > 8) {
      const oldest = this.creations.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.creations.get(oldest);
      this.creations.delete(oldest);
      disposeImages(evicted?.images ?? []);
    }
    this.notifyCreations();
  }

  acceptCreation(id: ThreadId, submissionId: string): void {
    const creation = this.creations.get(id);
    if (creation === undefined) return;
    this.creations.set(id, { ...creation, submissionId });
    this.notifyCreations();
  }

  completeCreation(id: ThreadId, submissionId: string): void {
    const creation = this.creations.get(id);
    if (creation?.submissionId !== submissionId) return;
    this.creations.delete(id);
    disposeImages(creation.images);
    this.notifyCreations();
  }

  failCreation(id: ThreadId): OptimisticThreadCreation | undefined {
    const creation = this.creations.get(id);
    // Admission is final: keep the optimistic projection until Flue exposes the
    // matching receipt and completeCreation releases its attachment previews.
    if (creation === undefined || creation.submissionId !== undefined)
      return undefined;
    this.creations.delete(id);
    this.notifyCreations();
    return creation;
  }

  retainFailedCreation(creation: FailedThreadCreation): void {
    disposeImages(this.failedCreation?.images ?? []);
    this.failedCreation = creation;
  }

  claimFailedCreation(): FailedThreadCreation | undefined {
    const creation = this.failedCreation;
    this.failedCreation = undefined;
    return creation;
  }

  private notifyCreations(): void {
    for (const listener of this.creationListeners) listener();
  }

  prepare(
    id: ThreadId,
    projectId: ProjectId,
    agentUrl: string,
    initialData?: ThreadAgentInitializationData,
  ): RetainedThread {
    const existing = this.entries.get(id);
    if (existing !== undefined) return existing;
    const client =
      initialData === undefined
        ? createFlueClient({ url: agentUrl, fetch: sameOriginFetch })
        : createThreadAgentClient(agentUrl, initialData);
    return {
      id,
      projectId,
      client,
      session: createFlueAgentSession({ client, live: "sse", promptLimit: 2 }),
      dictation: new DictationRecoverySession(),
      presentation: new Map(),
      presentationListeners: new Set(),
      images: createPendingImageCollection(),
      disposed: false,
    };
  }

  activate(entry: RetainedThread): () => void {
    if (entry.disposed) return () => {};
    this.active?.entry.session.stop();
    const generation = ++this.generation;
    this.active = { entry, generation };
    const retained = this.entries.has(entry.id);
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    if (!retained) {
      const thread = new QueryObserver(this.queryClient, {
        ...threadQueryOptions(this.userId, entry.id),
        enabled: false,
        refetchInterval: false,
      });
      const project = new QueryObserver(this.queryClient, {
        ...projectQueryOptions(this.userId, entry.projectId),
        enabled: false,
      });
      const revoke = (error: unknown) => {
        if (isAuthorizationError(error)) this.remove(entry.id);
      };
      const releaseThread = thread.subscribe((result) => revoke(result.error));
      const releaseProject = project.subscribe((result) =>
        revoke(result.error),
      );
      this.releases.set(entry.id, () => {
        releaseThread();
        releaseProject();
      });
    }
    while (this.entries.size > 8) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
    entry.session.start();
    return () => {
      if (this.active?.generation !== generation) return;
      entry.session.stop();
      this.active = undefined;
    };
  }

  remove(id: ThreadId): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (this.active?.entry === entry) this.active = undefined;
    entry.disposed = true;
    this.entries.delete(id);
    this.releases.get(id)?.();
    this.releases.delete(id);
    for (const listener of entry.presentationListeners) listener();
    entry.presentationListeners.clear();
    entry.presentation.clear();
    entry.dictation.clear();
    entry.session.dispose();
    entry.images.dispose();
    disposeImages(entry.pendingSubmissionImages ?? []);
    entry.pendingSubmissionImages = undefined;
    void entry.images.settle().then(() => entry.images.dispose());
  }

  clear(): void {
    for (const id of this.entries.keys()) this.remove(id);
    for (const creation of this.creations.values())
      disposeImages(creation.images);
    this.creations.clear();
    disposeImages(this.failedCreation?.images ?? []);
    this.failedCreation = undefined;
    this.notifyCreations();
  }
}
