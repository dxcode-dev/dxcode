import {
  type ProjectData,
  type ThreadAgentInitializationData,
  threadAgentUrl,
} from "@dx/api";
import type {
  ClaudeCodeEffort,
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
  createPendingAttachmentCollection,
  disposeAttachments,
  type PendingAttachment,
} from "./image-attachments.js";
import { threadQueryOptions } from "./thread-queries.js";

/** The first send creates the agent with `initialData` once it is known. */
export const createThreadAgentClient = (
  agentUrl: string,
  initialData: () => ThreadAgentInitializationData | undefined,
): FlueClient => {
  const client = createFlueClient({ url: agentUrl, fetch: sameOriginFetch });
  const send = client.send.bind(client);
  let initializing = true;
  client.send = async (options) => {
    const data = initialData();
    if (!initializing || data === undefined) return send(options);
    try {
      const receipt = await send({
        ...options,
        uid: null,
        initialData: data,
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
  /** Set from the Thread detail, which loads alongside the history. */
  agentInitialization?: ThreadAgentInitializationData;
  readonly client: FlueClient;
  readonly session: FlueAgentSession;
  readonly dictation: DictationRecoverySession;
  readonly presentation: Map<string, unknown>;
  readonly presentationListeners: Set<() => void>;
  readonly images: ReturnType<typeof createPendingAttachmentCollection>;
  pendingSubmissionImages?: ReadonlyArray<PendingAttachment>;
  disposed: boolean;
}

export interface PendingSubmissionImageRetention {
  readonly retain: (images: ReadonlyArray<PendingAttachment>) => boolean;
  readonly complete: (images: ReadonlyArray<PendingAttachment>) => boolean;
  readonly restore: (
    images: ReadonlyArray<PendingAttachment>,
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
  /** The Claude Code effort, with a Claude Code model only. */
  readonly effort?: ClaudeCodeEffort;
  readonly runnerProfileId?: RunnerProfileId;
  readonly body: string;
  readonly images: ReadonlyArray<PendingAttachment>;
  /** Epoch milliseconds when the user sent it; orders its sidebar row. */
  readonly startedAt: number;
  readonly submissionId?: string;
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
      disposeAttachments(images);
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
  private creationSnapshot: ReadonlyArray<OptimisticThreadCreation> = [];
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

  /** Every creation in flight or not yet seen in Flue, oldest first. */
  readonly pendingCreations = (): ReadonlyArray<OptimisticThreadCreation> =>
    this.creationSnapshot;

  beginCreation(creation: OptimisticThreadCreation): void {
    const previous = this.creations.get(creation.id);
    if (previous !== undefined && previous !== creation)
      disposeAttachments(previous.images);
    this.creations.delete(creation.id);
    this.creations.set(creation.id, creation);
    while (this.creations.size > 8) {
      const oldest = this.creations.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.creations.get(oldest);
      this.creations.delete(oldest);
      disposeAttachments(evicted?.images ?? []);
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
    disposeAttachments(creation.images);
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

  private notifyCreations(): void {
    this.creationSnapshot = [...this.creations.values()];
    for (const listener of this.creationListeners) listener();
  }

  /** Needs only the Thread id, so history loads alongside the Thread detail. */
  prepare(id: ThreadId, agentUrl: string = threadAgentUrl(id)): RetainedThread {
    const existing = this.entries.get(id);
    if (existing !== undefined) return existing;
    const client = createThreadAgentClient(
      agentUrl,
      () => entry.agentInitialization,
    );
    const entry: RetainedThread = {
      id,
      client,
      session: createFlueAgentSession({ client, live: "sse", promptLimit: 2 }),
      dictation: new DictationRecoverySession(),
      presentation: new Map(),
      presentationListeners: new Set(),
      images: createPendingAttachmentCollection(),
      disposed: false,
    };
    return entry;
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
      const revoke = (error: unknown) => {
        if (isAuthorizationError(error)) this.remove(entry.id);
      };
      let releaseProject: (() => void) | undefined;
      // The Project is known once the Thread detail loads.
      const watchProject = (projectId: ProjectId | undefined) => {
        if (releaseProject !== undefined || projectId === undefined) return;
        const project = new QueryObserver(this.queryClient, {
          ...projectQueryOptions(this.userId, projectId),
          enabled: false,
        });
        releaseProject = project.subscribe((result) => revoke(result.error));
      };
      const releaseThread = thread.subscribe((result) => {
        watchProject(result.data?.projectId);
        revoke(result.error);
      });
      watchProject(thread.getCurrentResult().data?.projectId);
      this.releases.set(entry.id, () => {
        releaseThread();
        releaseProject?.();
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
    disposeAttachments(entry.pendingSubmissionImages ?? []);
    entry.pendingSubmissionImages = undefined;
    void entry.images.settle().then(() => entry.images.dispose());
  }

  clear(): void {
    for (const id of this.entries.keys()) this.remove(id);
    for (const creation of this.creations.values())
      disposeAttachments(creation.images);
    this.creations.clear();
    this.notifyCreations();
  }
}
