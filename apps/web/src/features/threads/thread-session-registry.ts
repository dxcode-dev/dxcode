import {
  type ProjectData,
  type ThreadAgentInitializationData,
  threadAgentName,
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
import {
  type AgentConversationObservation,
  type AgentSendResult,
  createFlueClient,
  type FlueClient,
} from "@flue/sdk";
import { type QueryClient, QueryObserver } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";
import { projectQueryOptions } from "../projects/project-queries.js";
import { DictationRecoverySession } from "./dictation/dictation-session.js";
import { existingAgentUid } from "./existing-agent-uid.js";
import {
  createPendingAttachmentCollection,
  disposeAttachments,
  type PendingAttachment,
} from "./image-attachments.js";
import { sendRefusal } from "./send-failure.js";
import { threadQueryOptions } from "./thread-queries.js";

/**
 * Each history page holds the newest prompts that fit in 1 MiB of encoded
 * JSON, at most two and always at least one whole prompt, so a Thread with
 * large tool outputs does not paint megabytes. Older pages load on scroll.
 */
export const THREAD_HISTORY_PAGE = { promptLimit: 2, maxBytes: 1_048_576 };

/** Attempts per keyed send; the server deduplicates them by key. */
const SEND_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 500;

const AdmissionLookupSchema = Schema.Struct({
  state: Schema.Literal("accepted"),
  receipt: Schema.Struct({
    streamUrl: Schema.String,
    offset: Schema.String,
    submissionId: Schema.String,
    uid: Schema.String,
  }),
});

/** Flue's receipt for a key it already admitted, or `undefined`. */
const admittedReceipt = async (
  agentUrl: string,
  idempotencyKey: string,
): Promise<AgentSendResult | undefined> => {
  const url = new URL(agentUrl);
  url.searchParams.set("view", "admission");
  url.searchParams.set("idempotencyKey", idempotencyKey);
  try {
    const response = await sameOriginFetch(url, {
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const lookup = Schema.decodeUnknownOption(AdmissionLookupSchema)(
      await response.json(),
    );
    return Option.isSome(lookup) ? lookup.value.receipt : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The submission ID Flue derives from a keyed send, so a send can recognize
 * its own message in the conversation before its 202. Mirrors
 * `deriveKeyedSubmissionId` in Flue's runtime `ids.ts`, a frozen wire format.
 */
const keyedSubmissionId = async (agentUrl: string, idempotencyKey: string) => {
  const instanceId = decodeURIComponent(
    new URL(agentUrl).pathname.split("/").at(-1) ?? "",
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `flue-submission-key\n${threadAgentName}\n${instanceId}\n${idempotencyKey}`,
    ),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sub_ik_${hex.slice(0, 32)}`;
};

/**
 * Resolves once the observed conversation holds the user message of
 * `submissionId`: the server has it, whatever became of the 202.
 */
const observedSubmission = (
  observation: AgentConversationObservation | undefined,
  submissionId: string,
  signal: AbortSignal,
) =>
  new Promise<string | undefined>((resolve) => {
    if (observation === undefined || signal.aborted) return;
    const check = () => {
      const { conversation, offset } = observation.getSnapshot();
      if (
        conversation?.messages.some(
          (message) =>
            message.role === "user" && message.submissionId === submissionId,
        )
      ) {
        release();
        resolve(offset);
      }
    };
    const unsubscribe = observation.subscribe(check);
    const release = () => {
      unsubscribe();
      signal.removeEventListener("abort", release);
    };
    signal.addEventListener("abort", release);
    check();
  });

/**
 * Sends create the agent with `initialData` until its instance is known to
 * exist. A send whose outcome is unknown asks Flue whether it admitted the
 * key before trying again, so a lost 202 never becomes a failed send. The
 * send's own message arriving in the conversation is a receipt too, so a slow
 * 202 does not hold a message the server already has.
 */
export const createThreadAgentClient = (
  agentUrl: string,
  initialData: () => ThreadAgentInitializationData | undefined,
  instanceObserved: () => boolean = () => false,
): FlueClient => {
  const client = createFlueClient({ url: agentUrl, fetch: sameOriginFetch });
  const send = client.send.bind(client);
  const observe = client.observe;
  let observation: AgentConversationObservation | undefined;
  client.observe = (options) => {
    observation = observe.call(client, options);
    return observation;
  };
  let instanceKnown = false;
  let instanceUid: string | undefined;
  const deliver: FlueClient["send"] = async (options) => {
    const data = initialData();
    if (instanceKnown || instanceObserved() || data === undefined)
      return send(options);
    try {
      return await send({ ...options, uid: null, initialData: data });
    } catch (cause) {
      const uid = existingAgentUid(cause);
      if (uid === undefined) throw cause;
      instanceKnown = true;
      return send({ ...options, uid });
    }
  };
  const sendWithRetries: FlueClient["send"] = async (options) => {
    const key = options.idempotencyKey;
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
      try {
        const receipt = await deliver({
          ...options,
          signal:
            options.signal === undefined
              ? timeout
              : AbortSignal.any([options.signal, timeout]),
        });
        instanceKnown = true;
        instanceUid = receipt.uid;
        return receipt;
      } catch (cause) {
        if (
          key === undefined ||
          options.signal?.aborted === true ||
          sendRefusal(cause) !== undefined
        )
          throw cause;
        const receipt = await admittedReceipt(client.url, key);
        if (receipt !== undefined) {
          instanceKnown = true;
          instanceUid = receipt.uid;
          return receipt;
        }
        if (attempt === SEND_ATTEMPTS) throw cause;
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_BACKOFF_MS * attempt),
        );
      }
    }
  };
  client.send = async (options) => {
    const key = options.idempotencyKey;
    if (key === undefined) return sendWithRetries(options);
    const delivery = sendWithRetries(options);
    const received = new AbortController();
    const streamed = async (): Promise<AgentSendResult> => {
      const submissionId = await keyedSubmissionId(client.url, key);
      const offset = await observedSubmission(
        observation,
        submissionId,
        received.signal,
      );
      instanceKnown = true;
      return {
        streamUrl: client.url,
        offset: offset ?? "-1",
        submissionId,
        // Flue's session reads only a receipt's submission ID.
        uid: instanceUid ?? "",
      };
    };
    try {
      // Whichever receipt comes first; the 202 that loses changes nothing.
      return await Promise.race([delivery, streamed().catch(() => delivery)]);
    } finally {
      received.abort();
    }
  };
  return client;
};

export const isAuthorizationError = (error: unknown): boolean =>
  error instanceof Error &&
  "status" in error &&
  (error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 410);

/** The owner deleted this Thread; it never comes back. */
export const isDeletedThreadError = (error: unknown): boolean =>
  error instanceof Error && "status" in error && error.status === 410;

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
  disposed: boolean;
}

/** Records the Thread detail's agent initialization unless one is set. */
export const initializeRetainedThread = (
  entry: RetainedThread,
  agentInitialization: ThreadAgentInitializationData,
): RetainedThread => {
  entry.agentInitialization ??= agentInitialization;
  return entry;
};

/** Whether Stop was pressed while a send is being admitted. */
export interface PendingSubmissionControl {
  readonly stopRequested: () => boolean;
  readonly setStopRequested: (requested: boolean) => void;
}

export const createPendingSubmissionControl = (): PendingSubmissionControl => {
  let requested = false;
  return {
    stopRequested: () => requested,
    setStopRequested: (next) => {
      requested = next;
    },
  };
};

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
      // History read the instance: every Thread made with a first message.
      () => entry.session.getSnapshot().incarnation !== undefined,
    );
    const entry: RetainedThread = {
      id,
      client,
      session: createFlueAgentSession({
        client,
        live: "sse",
        ...THREAD_HISTORY_PAGE,
      }),
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
        releaseProject = project.subscribe((result) => {
          // A Thread kept from a deleted Project stays readable; its
          // Project answers 404 for good.
          if (thread.getCurrentResult().data?.projectDeleted !== true)
            revoke(result.error);
        });
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
