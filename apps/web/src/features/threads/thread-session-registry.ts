import {
  type ProjectData,
  type ThreadAgentInitializationData,
  type ThreadDetailData,
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
import {
  hashKey,
  type QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { Option, Schema } from "effect";
import {
  absentHistoryResponse,
  sameOriginFetch,
} from "../../shared/same-origin-fetch.js";
import { projectQueryOptions } from "../projects/project-queries.js";
import { DictationRecoverySession } from "./dictation/dictation-session.js";
import { existingAgentUid } from "./existing-agent-uid.js";
import {
  createPendingAttachmentCollection,
  disposeAttachments,
  type PendingAttachment,
} from "./image-attachments.js";
import { sendRefusal } from "./send-failure.js";
import { threadKeys, threadQueryOptions } from "./thread-queries.js";

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

/**
 * While a new Thread's first message is on its way to the agent, the
 * agent's conversation does not exist yet and reads answer 404. Flue's
 * client backs off for 1, 2, then 4 s; these reads try again sooner, so the
 * conversation shows as soon as the agent has it (#1590).
 */
const AGENT_START_POLL_MS = 250;
const AGENT_START_WAIT_MS = 15_000;

/** `fetch` that re-reads a 404 from the agent while `awaitingAgent()`. */
const agentStartFetch =
  (awaitingAgent: () => boolean): typeof fetch =>
  async (input, init) => {
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const started = Date.now();
    for (;;) {
      const response = await sameOriginFetch(input, init);
      if (
        response.status !== 404 ||
        method.toUpperCase() !== "GET" ||
        init?.signal?.aborted === true ||
        Date.now() - started >= AGENT_START_WAIT_MS ||
        !awaitingAgent()
      )
        return response;
      await response.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, AGENT_START_POLL_MS));
    }
  };

/**
 * Whether the agent's conversation is known not to exist yet: its history
 * answered 404 while no first message was on its way, as a new Space's does
 * until someone writes in it. Flue's session then re-reads history on a
 * backoff; those reads answer here without the network until a send from
 * this page, or `recheck` when the Thread changed, lets one through.
 */
export interface AbsentConversation {
  absent: boolean;
}

/** `fetch` that keeps a known-absent conversation's history reads local. */
const absentConversationFetch =
  (
    conversation: AbsentConversation,
    awaitingAgent: () => boolean,
    inner: typeof fetch,
  ): typeof fetch =>
  async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.href,
    );
    if (method !== "GET" || url.searchParams.get("view") !== "history") {
      const response = await inner(input, init);
      if (method === "POST" && response.ok) conversation.absent = false;
      return response;
    }
    if (conversation.absent && !awaitingAgent()) return absentHistoryResponse();
    const response = await inner(input, init);
    if (response.status === 404) conversation.absent = !awaitingAgent();
    else if (response.ok) conversation.absent = false;
    return response;
  };

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
 * A Thread's Flue client that also names the message Flue recorded for a
 * submission. Flue's session shows a message sent from this page under the
 * browser's local id (`local:1`) for good; comments and links need Flue's.
 */
export type ThreadAgentClient = FlueClient & {
  readonly admittedMessageId: (submissionId: string) => string | undefined;
  /**
   * Opens the live stream again from where it is, without reading history
   * again. Flue's stream loop hears new messages only on the agent instance
   * that wrote them; a connection held across the agent's Durable Object
   * starting again stays open but answers only at its 30 s idle tick.
   */
  readonly followAgain: () => void;
  /**
   * Where the live stream is, changing with everything it delivers;
   * undefined while it is not live.
   */
  readonly streamPosition: () => string | undefined;
};

/**
 * How long a live stream gets to deliver what the realtime hub announced
 * before it counts as deaf and opens again. The hub is usually a moment
 * ahead of a healthy stream; this keeps a deaf one's updates within ~3 s.
 */
export const QUIET_STREAM_MS = 1_500;

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
  /** The Thread's first message has not reached its agent yet. */
  awaitingAgent: () => boolean = () => false,
  conversation: AbsentConversation = { absent: false },
): ThreadAgentClient => {
  const client = createFlueClient({
    url: agentUrl,
    fetch: absentConversationFetch(
      conversation,
      awaitingAgent,
      agentStartFetch(awaitingAgent),
    ),
  });
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
  // The session reads the same observation, so a message it shows as
  // admitted is already in this conversation.
  const admittedMessageId = (submissionId: string) =>
    observation
      ?.getSnapshot()
      .conversation?.messages.findLast(
        (message) =>
          message.role === "user" && message.submissionId === submissionId,
      )?.id;
  const followAgain = () => {
    const observed = observation?.getSnapshot();
    if (observed?.phase !== "live" || observed.loadingOlder === true) return;
    observation?.stop();
    observation?.start();
  };
  const streamPosition = () => {
    const observed = observation?.getSnapshot();
    return observed?.phase === "live"
      ? `${observed.incarnation ?? ""}:${observed.offset ?? ""}`
      : undefined;
  };
  return Object.assign(client, {
    admittedMessageId,
    followAgain,
    streamPosition,
  });
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
  readonly client: ThreadAgentClient;
  readonly session: FlueAgentSession;
  readonly conversation: AbsentConversation;
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
  /**
   * Threads shown beside the page's own, such as a Space's child next to
   * the Space's chat: live alongside the active Thread, by how many views
   * show each.
   */
  private readonly alongside = new Map<RetainedThread, number>();

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
    const conversation: AbsentConversation = { absent: false };
    const client = createThreadAgentClient(
      agentUrl,
      () => entry.agentInitialization,
      // History read the instance: every Thread made with a first message.
      () => entry.session.getSnapshot().incarnation !== undefined,
      () =>
        this.queryClient.getQueryData<ThreadDetailData>(
          threadKeys.detail(this.userId, id),
        )?.initialDispatch?.state === "pending",
      conversation,
    );
    const entry: RetainedThread = {
      id,
      client,
      conversation,
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

  /**
   * Makes the Thread the page's live one, stopping the one before it, or,
   * with `alongside`, keeps it live beside the page's own Thread, as an
   * embedded Thread is, until its view lets go.
   */
  activate(
    entry: RetainedThread,
    { alongside = false }: { readonly alongside?: boolean } = {},
  ): () => void {
    if (entry.disposed) return () => {};
    this.retain(entry);
    if (alongside) {
      const views = this.alongside.get(entry) ?? 0;
      this.alongside.set(entry, views + 1);
      entry.session.start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (this.alongside.get(entry) ?? 1) - 1;
        if (left > 0) {
          this.alongside.set(entry, left);
          return;
        }
        this.alongside.delete(entry);
        if (this.active?.entry !== entry) entry.session.stop();
      };
    }
    const previous = this.active?.entry;
    if (previous !== undefined && !this.alongside.has(previous))
      previous.session.stop();
    const generation = ++this.generation;
    this.active = { entry, generation };
    entry.session.start();
    return () => {
      if (this.active?.generation !== generation) return;
      if (!this.alongside.has(entry)) entry.session.stop();
      this.active = undefined;
    };
  }

  /** Keeps the Thread among the eight most recent, watching its access. */
  private retain(entry: RetainedThread): void {
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
      let detail = thread.getCurrentResult().data;
      const releaseThread = thread.subscribe((result) => {
        watchProject(result.data?.projectId);
        revoke(result.error);
        // The Thread changed while its conversation was absent, as when
        // someone writes a new Space's first message: read it once more.
        // Its first load comes with the history read it would repeat.
        const previous = detail;
        detail = result.data;
        if (
          previous === undefined ||
          result.data === previous ||
          !entry.conversation.absent
        )
          return;
        entry.conversation.absent = false;
        entry.session.refresh();
      });
      watchProject(thread.getCurrentResult().data?.projectId);
      // The realtime hub says on time that the Thread changed, and the
      // Thread's detail is read again. A live stream that delivers nothing
      // within QUIET_STREAM_MS may have stopped hearing new messages: it
      // opens again, so they show as on a new page. One that delivers stays.
      const detailHash = hashKey(threadKeys.detail(this.userId, entry.id));
      const shown = () =>
        !entry.disposed &&
        (this.active?.entry === entry || this.alongside.has(entry));
      let quietCheck: ReturnType<typeof setTimeout> | undefined;
      const releaseInvalidation = this.queryClient
        .getQueryCache()
        .subscribe((event) => {
          if (
            event.type !== "updated" ||
            event.action.type !== "invalidate" ||
            event.query.queryHash !== detailHash ||
            quietCheck !== undefined ||
            !shown()
          )
            return;
          const position = entry.client.streamPosition();
          if (position === undefined) return;
          quietCheck = setTimeout(() => {
            quietCheck = undefined;
            if (shown() && entry.client.streamPosition() === position)
              entry.client.followAgain();
          }, QUIET_STREAM_MS);
        });
      this.releases.set(entry.id, () => {
        releaseThread();
        releaseProject?.();
        releaseInvalidation();
        clearTimeout(quietCheck);
      });
    }
    while (this.entries.size > 8) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
  }

  remove(id: ThreadId): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (this.active?.entry === entry) this.active = undefined;
    this.alongside.delete(entry);
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
