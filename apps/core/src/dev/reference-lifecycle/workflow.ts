import {
  CreateProjectResponseSchema,
  CreateThreadResponseSchema,
  parseMessageAuthor,
  threadAgentUrl,
} from "@dx/api";
import { newThreadId, type ProjectId, type ThreadId } from "@dx/domain";
import {
  createFlueClient,
  FlueApiError,
  type FlueClient,
  type AgentConversationObservation,
  type AgentConversationObservationSnapshot,
  type AgentSendResult,
  type FlueConversationSnapshot,
  FlueExecutionError,
} from "@flue/sdk";
import { Redacted, Schema } from "effect";
import type { ReferenceLifecycleConfig } from "./config.js";

const STAGE = [
  "project_create",
  "thread_create",
  "thread_handoff",
  "first_submission",
  "first_observation",
  "local_cancellation",
  "first_settlement",
  "reconnect",
  "continuation_settlement",
  "abort_active_admission",
  "abort_active_observation",
  "abort_queued_admission",
  "abort_receipt",
  "abort_active_settlement",
  "abort_queued_settlement",
  "abort_history",
  "post_abort_continuation",
] as const;

export type ReferenceLifecycleStage = (typeof STAGE)[number];

export class ReferenceLifecycleError extends Schema.TaggedError<ReferenceLifecycleError>()(
  "ReferenceLifecycleError",
  {
    stage: Schema.Literals(STAGE),
    status: Schema.optional(Schema.Number),
    ref: Schema.optional(Schema.String),
  },
) {}

export interface ReferenceLifecycleEvidence {
  readonly threadId: ThreadId;
  readonly initialSubmission: {
    readonly submissionId: string;
    readonly streamUrl: string;
  };
  readonly continuationSubmissionId: string;
  readonly continuationUid: string;
  readonly activeAbort: {
    readonly submissionId: string;
    readonly outcome: "aborted";
  };
  readonly queuedAbort: {
    readonly submissionId: string;
    readonly outcome: "aborted";
  };
  readonly abortReceipt: boolean;
  readonly postAbortSubmissionId: string;
  readonly historyMessageCount: number;
  readonly headerResolutionCount: number;
}

export interface RunReferenceLifecycleOptions {
  readonly fetch?: typeof fetch;
}

const TIMEOUT_MS = 15_000;
const MARKER_PATH = "/home/user/dx-reference-marker.txt";
const IMAGE_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const INITIAL_PROMPT = `Write the marker reference-lifecycle to ${MARKER_PATH}, then confirm completion.`;

const lifecycleError = (
  stage: ReferenceLifecycleStage,
  error?: unknown,
): ReferenceLifecycleError =>
  new ReferenceLifecycleError({
    stage,
    ...(error instanceof FlueApiError ? { status: error.status } : {}),
    ...(error instanceof FlueApiError && error.ref !== undefined
      ? { ref: error.ref }
      : {}),
  });

const waitForObservation = (
  observation: AgentConversationObservation,
  stage: ReferenceLifecycleStage,
  predicate: (snapshot: AgentConversationObservationSnapshot) => boolean,
) =>
  new Promise<AgentConversationObservationSnapshot>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const finish = (snapshot: AgentConversationObservationSnapshot) => {
      if (settled || !predicate(snapshot)) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    };
    unsubscribe = observation.subscribe(() =>
      finish(observation.getSnapshot()),
    );
    if (!settled) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(lifecycleError(stage));
      }, TIMEOUT_MS);
    }
    finish(observation.getSnapshot());
  });

const hasSubmissionMessage = (
  snapshot: AgentConversationObservationSnapshot,
  submissionId: string,
) =>
  snapshot.conversation?.messages.some(
    (message) => message.submissionId === submissionId,
  ) === true;

const initialSubmissionId = (snapshot: FlueConversationSnapshot) =>
  snapshot.messages.find(
    (message) =>
      message.role === "user" &&
      message.parts.some(
        (part) =>
          part.type === "text" &&
          parseMessageAuthor(part.text).text === INITIAL_PROMPT,
      ),
  )?.submissionId;

const hasPendingTool = (
  snapshot: AgentConversationObservationSnapshot,
  submissionId: string,
) =>
  snapshot.conversation?.messages.some(
    (message) =>
      message.submissionId === submissionId &&
      message.parts.some(
        (part) =>
          part.type === "dynamic-tool" && part.state === "input-available",
      ),
  ) === true;

const expectAborted = async (
  client: FlueClient,
  admission: AgentSendResult,
  stage: "abort_active_settlement" | "abort_queued_settlement",
) => {
  try {
    await client.wait(admission);
  } catch (error) {
    if (error instanceof FlueExecutionError && error.failure === "aborted") {
      return "aborted" as const;
    }
    throw lifecycleError(stage, error);
  }
  throw lifecycleError(stage);
};

export const runReferenceLifecycle = async (
  config: ReferenceLifecycleConfig,
  options: RunReferenceLifecycleOptions = {},
): Promise<ReferenceLifecycleEvidence> => {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  let headerResolutionCount = 0;
  const resolveHeaders = async () => {
    headerResolutionCount += 1;
    return {
      authorization: `Bearer ${Redacted.value(config.apiToken)}`,
      "x-dx-reference-request": String(headerResolutionCount),
    };
  };

  let projectId: ProjectId;
  if (config.project.kind === "existing") {
    projectId = config.project.id;
  } else {
    try {
      const response = await fetchImpl(
        new URL("/v1/projects", config.baseUrl),
        {
          method: "POST",
          headers: {
            ...(await resolveHeaders()),
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: config.project.name }),
        },
      );
      if (!response.ok) throw new Error("Product request failed.");
      projectId = (
        await Schema.decodeUnknownPromise(CreateProjectResponseSchema)(
          await response.json(),
        )
      ).data.id;
    } catch (error) {
      throw lifecycleError("project_create", error);
    }
  }

  let thread: typeof CreateThreadResponseSchema.Type.data;
  try {
    const response = await fetchImpl(new URL("/v1/threads", config.baseUrl), {
      method: "POST",
      headers: {
        ...(await resolveHeaders()),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        title: "Reference lifecycle",
        threadId: newThreadId(),
        initialMessage: {
          body: INITIAL_PROMPT,
          attachments: [
            {
              type: "image",
              data: IMAGE_DATA,
              mimeType: "image/png",
              filename: "reference.png",
            },
          ],
        },
      }),
    });
    if (!response.ok) throw new Error("Product request failed.");
    thread = (
      await Schema.decodeUnknownPromise(CreateThreadResponseSchema)(
        await response.json(),
      )
    ).data;
  } catch (error) {
    throw lifecycleError("thread_create", error);
  }

  const expectedAgentUrl = threadAgentUrl(thread.id);
  let absoluteAgentUrl: URL;
  try {
    if (
      thread.agentUrl !== expectedAgentUrl ||
      !thread.agentUrl.startsWith("/")
    ) {
      throw new Error("Thread handoff is inconsistent.");
    }
    absoluteAgentUrl = new URL(thread.agentUrl, config.baseUrl);
    if (
      absoluteAgentUrl.origin !== config.baseUrl.origin ||
      absoluteAgentUrl.search !== "" ||
      absoluteAgentUrl.hash !== ""
    ) {
      throw new Error("Thread handoff is invalid.");
    }
  } catch (error) {
    throw lifecycleError("thread_handoff", error);
  }

  const client = createFlueClient({
    url: absoluteAgentUrl.toString(),
    fetch: fetchImpl,
    headers: resolveHeaders,
  });

  let firstSubmission: string;
  try {
    const history = await client.history();
    const submissionId = initialSubmissionId(history);
    if (submissionId === undefined)
      throw new Error("Initial Thread prompt is missing from history.");
    firstSubmission = submissionId;
  } catch (error) {
    throw lifecycleError("first_submission", error);
  }

  const firstObservation = client.observe();
  try {
    await waitForObservation(
      firstObservation,
      "first_observation",
      (snapshot) => hasSubmissionMessage(snapshot, firstSubmission),
    );
  } finally {
    firstObservation.close();
  }

  const localController = new AbortController();
  try {
    await client.read(firstSubmission, {
      signal: localController.signal,
      onEvent: () => localController.abort(),
    });
    throw lifecycleError("local_cancellation");
  } catch (error) {
    if (error instanceof ReferenceLifecycleError) throw error;
    if (!localController.signal.aborted) {
      throw lifecycleError("local_cancellation", error);
    }
  }

  try {
    await client.read(firstSubmission);
  } catch (error) {
    throw lifecycleError("first_settlement", error);
  }

  let history: FlueConversationSnapshot;
  try {
    history = await client.history();
    const reconnect = client.observe();
    try {
      await waitForObservation(
        reconnect,
        "reconnect",
        (snapshot) =>
          snapshot.phase === "live" && snapshot.conversation !== undefined,
      );
    } finally {
      reconnect.close();
    }
  } catch (error) {
    throw lifecycleError("reconnect", error);
  }

  let continuation: AgentSendResult;
  try {
    continuation = await client.send({
      message: {
        kind: "user",
        body: `Read ${MARKER_PATH} and continue this conversation with its value.`,
      },
    });
    await client.read(continuation);
  } catch (error) {
    throw lifecycleError("continuation_settlement", error);
  }

  let activeAbort: AgentSendResult;
  try {
    activeAbort = await client.send({
      uid: continuation.uid,
      message: {
        kind: "user",
        body: "Run the delayed reference command with bash and wait for it.",
      },
    });
  } catch (error) {
    throw lifecycleError("abort_active_admission", error);
  }

  const abortObservation = client.observe();
  try {
    await waitForObservation(
      abortObservation,
      "abort_active_observation",
      (snapshot) => hasPendingTool(snapshot, activeAbort.submissionId),
    );
  } catch (error) {
    abortObservation.close();
    throw lifecycleError("abort_active_observation", error);
  }

  let queuedAbort: AgentSendResult;
  try {
    queuedAbort = await client.send({
      uid: continuation.uid,
      message: {
        kind: "user",
        body: "Queue this follow-up behind the active delayed command.",
      },
    });
  } catch (error) {
    abortObservation.close();
    throw lifecycleError("abort_queued_admission", error);
  }

  let abortReceipt: boolean;
  try {
    abortReceipt = (await client.abort()).aborted;
  } catch (error) {
    abortObservation.close();
    throw lifecycleError("abort_receipt", error);
  }
  abortObservation.close();

  const [activeOutcome, queuedOutcome] = await Promise.all([
    expectAborted(client, activeAbort, "abort_active_settlement"),
    expectAborted(client, queuedAbort, "abort_queued_settlement"),
  ]);

  try {
    history = await client.history();
    for (const admission of [activeAbort, queuedAbort]) {
      if (
        !history.settlements.some(
          (settlement) =>
            settlement.submissionId === admission.submissionId &&
            settlement.outcome === "aborted",
        )
      ) {
        throw new Error("Abort settlement is missing.");
      }
    }
  } catch (error) {
    throw lifecycleError("abort_history", error);
  }

  let postAbort: AgentSendResult;
  try {
    postAbort = await client.send({
      uid: continuation.uid,
      message: {
        kind: "user",
        body: "Confirm the reference lifecycle can continue after settlement.",
      },
    });
    await client.read(postAbort);
  } catch (error) {
    throw lifecycleError("post_abort_continuation", error);
  }

  return {
    threadId: thread.id,
    initialSubmission: {
      submissionId: firstSubmission,
      streamUrl: absoluteAgentUrl.toString(),
    },
    continuationSubmissionId: continuation.submissionId,
    continuationUid: continuation.uid,
    activeAbort: {
      submissionId: activeAbort.submissionId,
      outcome: activeOutcome,
    },
    queuedAbort: {
      submissionId: queuedAbort.submissionId,
      outcome: queuedOutcome,
    },
    abortReceipt,
    postAbortSubmissionId: postAbort.submissionId,
    historyMessageCount: history.messages.length,
    headerResolutionCount,
  };
};

export const formatReferenceLifecycleError = (error: unknown) => {
  if (error instanceof ReferenceLifecycleError) {
    return JSON.stringify({
      status: "error",
      stage: error.stage,
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
      ...(error.ref === undefined ? {} : { ref: error.ref }),
    });
  }
  return JSON.stringify({ status: "error", stage: "configuration" });
};
