import { type ThreadAgentInitializationData, threadAgentName } from "@dx/api";
import {
  type AgentConversationObservation,
  type AgentSendResult,
  createFlueClient,
  type FlueClient,
} from "@flue/sdk";
import { Option, Schema } from "effect";
import { absentHistoryResponse } from "./absent-history.js";
import { existingAgentUid } from "./existing-agent-uid.js";
import { sendRefusal } from "./send-refusal.js";

/**
 * A Thread's Flue client: keyed sends that survive a lost answer, history
 * reads that wait for a new Thread's agent, and a known-absent conversation
 * that does not hit the network. Any UI that talks to a Thread's agent uses
 * it; the UI passes its fetch and origin.
 */

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
  (inner: typeof fetch, awaitingAgent: () => boolean): typeof fetch =>
  async (input, init) => {
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const started = Date.now();
    for (;;) {
      const response = await inner(input, init);
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
    origin: string,
  ): typeof fetch =>
  async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      origin,
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
  fetch: typeof globalThis.fetch,
  agentUrl: string,
  idempotencyKey: string,
): Promise<AgentSendResult | undefined> => {
  const url = new URL(agentUrl);
  url.searchParams.set("view", "admission");
  url.searchParams.set("idempotencyKey", idempotencyKey);
  try {
    const response = await fetch(url, {
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

export interface ThreadAgentClientOptions {
  /** The Thread's agent, such as `threadAgentUrl(threadId)`. */
  readonly agentUrl: string;
  /** How requests reach dx: the web's same-origin fetch, a shell's authenticated one. */
  readonly fetch: typeof globalThis.fetch;
  /** The dx origin, for request URLs Flue leaves relative. */
  readonly origin: string;
  readonly initialData: () => ThreadAgentInitializationData | undefined;
  /** History read the agent's instance. */
  readonly instanceObserved?: () => boolean;
  /** The Thread's first message has not reached its agent yet. */
  readonly awaitingAgent?: () => boolean;
  readonly conversation?: AbsentConversation;
}

/**
 * Sends create the agent with `initialData` until its instance is known to
 * exist. A send whose outcome is unknown asks Flue whether it admitted the
 * key before trying again, so a lost 202 never becomes a failed send. The
 * send's own message arriving in the conversation is a receipt too, so a slow
 * 202 does not hold a message the server already has.
 */
export const createThreadAgentClient = ({
  agentUrl,
  fetch,
  origin,
  initialData,
  instanceObserved = () => false,
  awaitingAgent = () => false,
  conversation = { absent: false },
}: ThreadAgentClientOptions): ThreadAgentClient => {
  const client = createFlueClient({
    url: agentUrl,
    fetch: absentConversationFetch(
      conversation,
      awaitingAgent,
      agentStartFetch(fetch, awaitingAgent),
      origin,
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
        const receipt = await admittedReceipt(fetch, client.url, key);
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
