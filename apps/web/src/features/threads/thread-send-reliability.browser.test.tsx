/**
 * Sending a message, end to end through dx's Thread session (registry, Flue
 * client wrapper, Flue session and reducer, agent panel) against a fake agent
 * server at the HTTP boundary. The server models Flue's keyed admission: a
 * submission row per idempotency key, `uid` conditions, and the admission
 * lookup at `GET <agent>?view=admission&idempotencyKey=K`.
 */
import type { ThreadAgentInitializationData } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import type { FlueAgentSession } from "@flue/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The user rows' text in every transcript render, oldest first. */
const transcriptRenders = vi.hoisted((): string[][] => []);

vi.mock("./thread-transcript.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-transcript.js")>()),
  INBOUND_MESSAGE_PREFIX: "inbound:",
  ThreadTranscript: ({
    model,
    footer,
  }: {
    readonly model: {
      readonly rows: ReadonlyArray<{
        readonly id: string;
        readonly kind: string;
        readonly text?: string;
      }>;
    };
    readonly footer?: React.ReactNode;
  }) => {
    transcriptRenders.push(
      model.rows
        .filter((row) => row.kind === "user-prompt")
        .map((row) => row.text ?? ""),
    );
    return (
      <section aria-label="Thread transcript">
        {model.rows.map((row) => (
          <p key={row.id} data-row-kind={row.kind}>
            {row.text}
          </p>
        ))}
        {footer}
      </section>
    );
  },
}));

// Uploads finish at once; the send is what these tests hold.
vi.mock("./attachment-upload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./attachment-upload.js")>()),
  startAttachmentUpload: (file: File) => {
    const attachment = {
      id: `att_${"1".repeat(32)}`,
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      url: `https://dx.example/v1/attachments/att_${"1".repeat(32)}/${file.name}`,
    };
    const ready = { status: "ready", attachment } as const;
    return {
      getSnapshot: () => ready,
      subscribe: () => () => {},
      settled: Promise.resolve(attachment),
      cancel: () => {},
    };
  },
}));

import { AgentPanel, type AgentPanelOptions } from "./agent-panel.js";
import type { ComposerMentions } from "./sharing/chat-composer.js";
import { ThreadSessionRegistry } from "./thread-session-registry.js";
import { useFrameCoalescedAgentSource } from "./use-frame-coalesced-agent-session.js";

const threadId = "thr_send_reliability" as ThreadId;
const agentUrl = `http://localhost/v1/agents/dx/${threadId}`;

/**
 * Flue's submission ID for a keyed send: `deriveKeyedSubmissionId` in its
 * runtime ids.ts, a frozen wire format, under Core's agent name `dx-agent`.
 */
const keyedSubmissionId = async (idempotencyKey: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `flue-submission-key\ndx-agent\n${threadId}\n${idempotencyKey}`,
    ),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sub_ik_${hex.slice(0, 32)}`;
};
const agentInitialization = {
  skills: [],
} as unknown as ThreadAgentInitializationData;

type Fault =
  | "offline"
  | "drop-response"
  | "drop-response-and-disconnect"
  | { readonly status: number; readonly body: unknown };

interface Submission {
  readonly submissionId: string;
  readonly message: unknown;
  readonly initialData: unknown;
}

/**
 * Flue's agent routes behind Core, in memory. `faults` script requests of a
 * kind in order: `offline` fails before the server sees the request, a status
 * with a body is Core or Flue refusing it, and `drop-response` loses the
 * answer of the next send Flue admits or replays (`-and-disconnect` also
 * leaves the network down until `reconnect`). A create-only send that meets
 * the instance answers 409 without taking a fault. After `streamCommits`, the
 * live updates view streams each message the server commits.
 */
const createAgentServer = ({ exists }: { readonly exists: boolean }) => {
  const uid = "agent-uid-1";
  let created = exists;
  const submissions = new Map<string, Submission>();
  const messages: unknown[] = exists
    ? [
        {
          id: "msg-earlier",
          role: "user",
          purpose: "user",
          display: "visible",
          submissionId: "sub_earlier",
          parts: [{ type: "text", text: "Earlier message", state: "done" }],
        },
      ]
    : [];
  const faults = {
    send: [] as Fault[],
    admission: [] as Fault[],
  };
  const requests: Array<{
    readonly method: string;
    readonly view?: string;
    readonly body?: Record<string, unknown>;
  }> = [];
  /** Core builds the stored body: its author tag can change between tries. */
  let authorName = "Ada";
  let holdHistory = false;
  let disconnected = false;
  /** While set, a send waits here before the server reads it. */
  let sendGate: Promise<void> | undefined;
  /** While set, a send the server committed waits here for its answer. */
  let answerGate: Promise<void> | undefined;
  let streamsCommits = false;
  /** Committed messages the live updates view has not delivered yet. */
  const unstreamed: unknown[] = [];
  let streamBatch = 0;
  let wakeStream: (() => void) | undefined;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const hang = (signal: AbortSignal | null | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")),
      );
    });
  const respond = (fault: Fault | undefined, response: () => Response) => {
    if (fault === "drop-response-and-disconnect") disconnected = true;
    if (fault === "drop-response" || fault === "drop-response-and-disconnect")
      throw new TypeError("Failed to fetch (response lost)");
    if (typeof fault === "object") return json(fault.body, fault.status);
    return response();
  };

  const admit = async (body: Record<string, unknown>) => {
    const keyedId = await keyedSubmissionId(String(body.idempotencyKey));
    const refusal = faults.send[0];
    if (typeof refusal === "object") {
      faults.send.shift();
      return json(refusal.body, refusal.status);
    }
    const { uid: condition, initialData, idempotencyKey, ...message } = body;
    const stored = {
      ...message,
      body: `<author name="${authorName}"/>${String(message.body)}`,
    };
    const key = String(idempotencyKey);
    const existing = submissions.get(key);
    if (
      existing === undefined &&
      ((condition === null && created) ||
        (typeof condition === "string" && (!created || condition !== uid)))
    )
      return condition === null
        ? json(
            {
              error: {
                type: "agent_instance_exists",
                message: "The agent instance already exists.",
                meta: { uid },
              },
            },
            409,
          )
        : json({ error: { type: "agent_not_found", message: "" } }, 404);
    const fault = faults.send.shift();
    if (existing !== undefined) {
      if (
        JSON.stringify(existing.message) !== JSON.stringify(stored) ||
        JSON.stringify(existing.initialData) !== JSON.stringify(initialData)
      )
        return json(
          {
            error: {
              type: "submission_conflict",
              message: "Idempotency key names another submission.",
              meta: { submissionId: existing.submissionId },
            },
          },
          409,
        );
      return respond(fault, () =>
        json(
          {
            streamUrl: agentUrl,
            offset: "-1",
            submissionId: existing.submissionId,
            uid,
            deduplicated: true,
          },
          202,
        ),
      );
    }
    created = true;
    const submissionId = keyedId;
    submissions.set(key, { submissionId, message: stored, initialData });
    const committed = [
      {
        id: `msg-${submissionId}`,
        role: "user",
        purpose: "user",
        display: "visible",
        submissionId,
        parts: [{ type: "text", text: String(message.body), state: "done" }],
      },
      // The agent starts answering at once.
      {
        id: `answer-${submissionId}`,
        role: "assistant",
        purpose: "assistant",
        display: "visible",
        submissionId,
        parts: [{ type: "text", text: "Working on it", state: "streaming" }],
      },
    ];
    messages.push(...committed);
    if (streamsCommits) {
      unstreamed.push(
        ...committed.map((committedMessage) => ({
          type: "message-appended",
          conversationId: threadId,
          message: committedMessage,
          position: { batch: 1_000 + ++streamBatch, index: 0 },
        })),
      );
      wakeStream?.();
    }
    if (answerGate !== undefined) await answerGate;
    return respond(fault, () =>
      json({ streamUrl: agentUrl, offset: "7", submissionId, uid }, 202),
    );
  };

  const fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const view = url.searchParams.get("view") ?? undefined;
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    requests.push({ method, ...(view ? { view } : {}), ...(body && { body }) });
    if (disconnected && view !== "history")
      throw new TypeError("Failed to fetch");
    if (method === "POST") {
      if (sendGate !== undefined) await sendGate;
      if (faults.send[0] === "offline") {
        faults.send.shift();
        throw new TypeError("Failed to fetch");
      }
      return admit(body ?? {});
    }
    if (view === "admission") {
      const fault = faults.admission.shift();
      if (fault === "offline") throw new TypeError("Failed to fetch");
      return respond(fault, () => {
        const submission = submissions.get(
          url.searchParams.get("idempotencyKey") ?? "",
        );
        return json(
          submission === undefined
            ? { state: "absent" }
            : {
                state: "accepted",
                receipt: {
                  streamUrl: agentUrl,
                  offset: "-1",
                  submissionId: submission.submissionId,
                  uid,
                },
                acceptedAt: new Date(0).toISOString(),
              },
        );
      });
    }
    if (view === "history") {
      if (holdHistory) return hang(init?.signal);
      if (!created)
        return json({ error: { type: "agent_not_found", message: "" } }, 404);
      return json({
        v: 1,
        conversationId: threadId,
        offset: String(messages.length),
        incarnation: "stream-generation-1",
        historyRevision: "revision-1",
        olderCursor: null,
        messages: [...messages],
        // The earlier message's run finished.
        settlements: exists
          ? [{ submissionId: "sub_earlier", outcome: "completed" }]
          : [],
        finalOutputs: [],
      });
    }
    if (view === "updates") {
      if (unstreamed.length === 0)
        await new Promise<void>((resolve, reject) => {
          wakeStream = resolve;
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      return new Response(JSON.stringify(unstreamed.splice(0)), {
        headers: {
          "content-type": "application/json",
          "Stream-Next-Offset": String(1_000 + streamBatch),
        },
      });
    }
    // Live updates stay open until the observation closes them.
    return hang(init?.signal);
  };

  return {
    fetch,
    faults,
    requests,
    submissions,
    holdHistory: (hold: boolean) => {
      holdHistory = hold;
    },
    /** Holds every send until the returned release is called. */
    holdSends: () => {
      let release = () => {};
      sendGate = new Promise<void>((resolve) => {
        release = () => {
          sendGate = undefined;
          resolve();
        };
      });
      return () => React.act(async () => release());
    },
    /** Holds every committed send's answer until the returned release. */
    holdAnswers: () => {
      let release = () => {};
      answerGate = new Promise<void>((resolve) => {
        release = () => {
          answerGate = undefined;
          resolve();
        };
      });
      return () => React.act(async () => release());
    },
    streamCommits: () => {
      streamsCommits = true;
    },
    reconnect: () => {
      disconnected = false;
    },
    rename: (name: string) => {
      authorName = name;
    },
    sends: () => requests.filter(({ method }) => method === "POST"),
    lookups: () => requests.filter(({ view }) => view === "admission"),
  };
};

type PanelProps = Partial<AgentPanelOptions>;

/** The retained Thread's panel, as `SessionAgentPanel` renders it. */
function SessionPanel({
  session,
  ...props
}: PanelProps & { readonly session: FlueAgentSession }) {
  const source = useFrameCoalescedAgentSource(session);
  return <AgentPanel source={source} {...props} />;
}

const open = async (
  server: ReturnType<typeof createAgentServer>,
  props: PanelProps = {},
) => {
  vi.stubGlobal("fetch", server.fetch);
  // A browser frame, not happy-dom's next-task animation frame: the agent
  // snapshot then lags React state as it does in Chromium.
  vi.stubGlobal("requestAnimationFrame", (paint: FrameRequestCallback) =>
    setTimeout(() => paint(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => clearTimeout(frame));
  const queryClient = new QueryClient();
  const registry = new ThreadSessionRegistry(queryClient, "usr_1" as UserId);
  const entry = registry.prepare(threadId, agentUrl);
  entry.agentInitialization = agentInitialization;
  const release = registry.activate(entry);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <SessionPanel session={entry.session} {...props} />
      </QueryClientProvider>,
    ),
  );
  const textarea = () => {
    const element = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    );
    if (element === null) throw new Error("Expected the composer.");
    return element;
  };
  const write = (text: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const type = (text: string) =>
    React.act(async () => {
      write(text);
      await Promise.resolve();
    });
  const send = async (text: string) => {
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    await React.act(async () => {
      write(text);
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
  };
  /** Waits until the composer accepted or gave up on the send. */
  const settled = () =>
    vi.waitFor(() => expect(textarea().disabled).toBe(false), {
      timeout: 5_000,
    });
  const card = () =>
    container.querySelector(".thread-error-card")?.textContent ?? "";
  const userRows = (text: string) =>
    [...container.querySelectorAll('[data-row-kind="user-prompt"]')].filter(
      (row) => row.textContent === text,
    ).length;
  /** How many user rows showed `text` in each transcript render so far. */
  const rowsInEveryRender = (text: string) =>
    transcriptRenders.map(
      (rows) => rows.filter((rowText) => rowText === text).length,
    );
  /** Lets a few frames pass, so frame-coalesced snapshots render. */
  const frames = () =>
    React.act(() => new Promise((resolve) => setTimeout(resolve, 80)));
  const historyLoaded = () =>
    vi.waitFor(() => expect(userRows("Earlier message")).toBe(1));
  const submitButton = () => {
    const button = container.querySelector<HTMLButtonElement>(
      'button[type="submit"].composer-submit',
    );
    if (button === null) throw new Error("Expected the Send button.");
    return button;
  };
  /** The Send button shows the New Thread composer's pending mark. */
  const sending = () =>
    submitButton().getAttribute("aria-busy") === "true" &&
    submitButton().hasAttribute("data-submitting") &&
    submitButton().querySelector(".processing-dot.dictation-processing-dot") !==
      null &&
    submitButton().querySelector("svg") === null;
  /** Send shows its arrow again and nothing marks it pending. */
  const arrowBack = () =>
    submitButton().querySelector("svg") !== null &&
    submitButton().querySelector(".processing-dot") === null &&
    !submitButton().hasAttribute("aria-busy") &&
    !submitButton().hasAttribute("data-submitting");
  /** Nothing marks Send pending: Stop replaced it, or it shows its arrow. */
  const sendSettled = () =>
    container.querySelector('button[type="submit"].composer-submit') === null ||
    arrowBack();
  const pressEnter = () =>
    React.act(async () => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
  const attach = async (file: File) => {
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("Expected the file input.");
    await React.act(async () => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(
        container.querySelector(`[aria-label="Preview ${file.name}"]`),
      ).not.toBeNull(),
    );
  };
  const preview = (name: string) =>
    container.querySelector(`[aria-label="Preview ${name}"]`);
  const close = async () => {
    await React.act(() => root.unmount());
    release();
    registry.clear();
  };
  return {
    container,
    textarea,
    type,
    send,
    settled,
    card,
    userRows,
    rowsInEveryRender,
    frames,
    historyLoaded,
    submitButton,
    sending,
    arrowBack,
    sendSettled,
    pressEnter,
    attach,
    preview,
    close,
  };
};

afterEach(() => {
  transcriptRenders.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** A shared Thread in chat mode: a message to the members runs nothing. */
const chatMentions = {
  mode: "members",
  members: [],
  viewerId: "usr_1",
  conversationMode: "chat",
  onSent: () => {},
} satisfies ComposerMentions;

const png = () =>
  new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    "held.png",
    { type: "image/png" },
  );

describe("a message shows as sent only once the server has it", () => {
  it.each([
    { kind: "follow-up", steer: false, props: {} },
    { kind: "steering message while the agent works", steer: true, props: {} },
    {
      kind: "chat message in a shared Thread",
      steer: false,
      props: { mentions: chatMentions },
    },
    { kind: "message with a file", steer: false, props: {}, file: true },
  ])(
    "holds a $kind in the composer until its 202, then shows it once",
    async ({ steer, props, file }) => {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:held-preview");
      const server = createAgentServer({ exists: true });
      const panel = await open(server, props);
      await panel.historyLoaded();
      const stop = () =>
        panel.container.querySelector('[aria-label="Stop agent"]');
      if (steer) {
        await panel.send("Start the work");
        await panel.settled();
        await vi.waitFor(() => expect(stop()).not.toBeNull());
      }
      if (file) await panel.attach(png());
      const sendsBefore = server.sends().length;
      const release = server.holdSends();

      await panel.send("Held message");

      await vi.waitFor(() => expect(panel.sending()).toBe(true));
      expect(server.sends()).toHaveLength(sendsBefore + 1);
      expect(panel.userRows("Held message")).toBe(0);
      expect(panel.textarea().value).toBe("Held message");
      expect(panel.textarea().readOnly).toBe(true);
      expect(panel.textarea().disabled).toBe(true);
      expect(panel.submitButton().disabled).toBe(true);
      if (file) expect(panel.preview("held.png")).not.toBeNull();
      // Stop stays while the agent works; chat starts no run to stop.
      if (steer) expect(stop()).not.toBeNull();
      if (props.mentions !== undefined) expect(stop()).toBeNull();
      await panel.pressEnter();
      await React.act(async () => {
        panel.container
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await Promise.resolve();
      });
      expect(server.sends()).toHaveLength(sendsBefore + 1);

      await release();
      await panel.settled();

      await vi.waitFor(() => expect(panel.userRows("Held message")).toBe(1));
      expect(panel.textarea().value).toBe("");
      expect(panel.sendSettled()).toBe(true);
      if (file) expect(panel.preview("held.png")).toBeNull();
      expect(server.submissions.size).toBe(steer ? 2 : 1);
      await panel.close();
    },
  );

  it("keeps a refused message and its file in the composer, with the reason and no row", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:held-preview");
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();
    await panel.attach(png());
    const release = server.holdSends();
    server.faults.send.push({
      status: 409,
      body: { status: "error", data: { code: "THREAD_ARCHIVED", message: "" } },
    });

    await panel.send("Refused after a wait");
    await vi.waitFor(() => expect(panel.sending()).toBe(true));
    expect(panel.userRows("Refused after a wait")).toBe(0);
    await release();
    await panel.settled();

    await vi.waitFor(() =>
      expect(panel.card()).toContain("This thread is archived."),
    );
    expect(panel.textarea().value).toBe("Refused after a wait");
    expect(panel.preview("held.png")).not.toBeNull();
    expect(panel.userRows("Refused after a wait")).toBe(0);
    expect(panel.arrowBack()).toBe(true);
    expect(server.submissions.size).toBe(0);
    await panel.close();
  });

  it("sends an unedited message again under its key, so the server keeps one", async () => {
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();
    // The server commits, its answer is lost, and the network stays down
    // through the keyed retries and the admission lookup.
    server.faults.send.push("drop-response-and-disconnect");

    await panel.send("Kept through the outage");
    await panel.settled();

    await vi.waitFor(() =>
      expect(panel.card()).toContain("Check your connection."),
    );
    expect(panel.textarea().value).toBe("Kept through the outage");
    expect(panel.userRows("Kept through the outage")).toBe(0);
    expect(panel.arrowBack()).toBe(true);
    expect(server.submissions.size).toBe(1);
    // A person sees the failure no sooner than the frame that also renders
    // Flue's failed send.
    await panel.frames();

    server.reconnect();
    await panel.send("Kept through the outage");
    await panel.settled();

    await vi.waitFor(() =>
      expect(panel.userRows("Kept through the outage")).toBe(1),
    );
    expect(
      new Set(server.sends().map(({ body }) => body?.idempotencyKey)).size,
    ).toBe(1);
    expect(server.submissions.size).toBe(1);
    expect(panel.card()).toBe("");
    expect(panel.textarea().value).toBe("");
    await panel.close();
  });

  it("sends an edited message as a new one and drops the failed send", async () => {
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();
    server.faults.send.push("offline", "offline", "offline");
    server.faults.admission.push("offline", "offline", "offline");

    await panel.send("First wording");
    await panel.settled();
    await vi.waitFor(() =>
      expect(panel.card()).toContain("Check your connection."),
    );
    expect(panel.textarea().value).toBe("First wording");
    const failedKey = server.sends().at(-1)?.body?.idempotencyKey;
    // A person sees the failure no sooner than the frame that also renders
    // Flue's failed send.
    await panel.frames();

    await panel.send("Second wording");
    await panel.settled();

    await vi.waitFor(() => expect(panel.userRows("Second wording")).toBe(1));
    expect(panel.userRows("First wording")).toBe(0);
    expect(panel.card()).toBe("");
    expect(panel.textarea().value).toBe("");
    expect(server.sends().at(-1)?.body?.idempotencyKey).not.toBe(failedKey);
    expect(server.submissions.size).toBe(1);
    await panel.close();
  });
});

describe("a message's own row on the stream confirms it, and it never shows twice or unsent", () => {
  it("clears the composer when the row streams in before the 202, and the late 202 changes nothing", async () => {
    const server = createAgentServer({ exists: true });
    server.streamCommits();
    const panel = await open(server);
    await panel.historyLoaded();
    const answer = server.holdAnswers();

    await panel.send("Streamed before its 202");

    await vi.waitFor(() =>
      expect(panel.userRows("Streamed before its 202")).toBe(1),
    );
    expect(server.submissions.size).toBe(1);
    await vi.waitFor(() => expect(panel.textarea().value).toBe(""));
    expect(panel.sendSettled()).toBe(true);
    expect(panel.textarea().readOnly).toBe(false);
    expect(panel.card()).toBe("");
    await panel.type("Next thought");

    await answer();
    await panel.frames();

    expect(panel.userRows("Streamed before its 202")).toBe(1);
    expect(panel.textarea().value).toBe("Next thought");
    expect(panel.arrowBack()).toBe(true);
    expect(panel.card()).toBe("");
    expect(server.sends()).toHaveLength(1);
    expect(
      Math.max(...panel.rowsInEveryRender("Streamed before its 202")),
    ).toBe(1);
    await panel.close();
  });

  it("never renders a refused message as a row, in any render", async () => {
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();
    const release = server.holdSends();
    server.faults.send.push({
      status: 409,
      body: { status: "error", data: { code: "THREAD_ARCHIVED", message: "" } },
    });

    await panel.send("Refused while held");
    await vi.waitFor(() => expect(panel.sending()).toBe(true));
    // Flue's pending echo reaches the rendered snapshot.
    await panel.frames();
    await release();
    await panel.settled();
    await vi.waitFor(() =>
      expect(panel.card()).toContain("This thread is archived."),
    );
    await panel.frames();

    expect(panel.textarea().value).toBe("Refused while held");
    expect(
      panel.rowsInEveryRender("Refused while held").filter((n) => n > 0),
    ).toEqual([]);
    await panel.close();
  });

  it("never renders two rows for a message when its 202 follows its streamed row", async () => {
    const server = createAgentServer({ exists: true });
    server.streamCommits();
    const panel = await open(server);
    await panel.historyLoaded();
    const release = server.holdSends();
    const answer = server.holdAnswers();

    await panel.send("Handed off");
    await vi.waitFor(() => expect(panel.sending()).toBe(true));
    await panel.frames();
    // The server commits and streams the row; its 202 comes after.
    await release();
    await vi.waitFor(() => expect(panel.userRows("Handed off")).toBe(1));
    await answer();
    await panel.settled();
    await panel.frames();

    expect(panel.userRows("Handed off")).toBe(1);
    expect(panel.textarea().value).toBe("");
    expect(Math.max(...panel.rowsInEveryRender("Handed off"))).toBe(1);
    await panel.close();
  });
});

describe("a message the server admitted is never reported as not sent", () => {
  it("adopts the admission when the 202 is lost after the server committed", async () => {
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();
    server.faults.send.push("drop-response");

    await panel.send("Ship the fix");
    await panel.settled();

    await vi.waitFor(() => expect(panel.userRows("Ship the fix")).toBe(1));
    expect(panel.card()).not.toContain("Message not sent");
    expect(server.submissions.size).toBe(1);
    expect(server.lookups()).toHaveLength(1);
    // The agent is answering the adopted submission: Stop, not Retry.
    expect(
      panel.container.querySelector('[aria-label="Stop agent"]'),
    ).not.toBeNull();
    expect(panel.textarea().value).toBe("");
    await panel.close();
  });

  it("retries a keyed send the server never saw", async () => {
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();
    server.faults.send.push("offline", { status: 502, body: "Bad gateway" });

    await panel.send("Try again quietly");
    await panel.settled();

    await vi.waitFor(() => expect(panel.userRows("Try again quietly")).toBe(1));
    expect(panel.card()).toBe("");
    expect(server.sends()).toHaveLength(3);
    expect(
      new Set(server.sends().map(({ body }) => body?.idempotencyKey)).size,
    ).toBe(1);
    expect(server.submissions.size).toBe(1);
    await panel.close();
  });

  it("adopts the original submission when Core rebuilt a different body for the retry", async () => {
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();
    server.faults.send.push("drop-response");
    server.faults.admission.push("offline");
    // The person renames themselves while the first response is lost, so
    // Core builds a different body for the retry and Flue answers 409.
    const serve = server.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (server.lookups().length > 0) server.rename("Ada Lovelace");
      return serve(input, init);
    });

    await panel.send("Rename-safe message");
    await panel.settled();

    // Lost answer, failed lookup, conflicting retry, lookup adopts it.
    expect(server.lookups()).toHaveLength(2);
    expect(
      new Set(server.sends().map(({ body }) => body?.idempotencyKey)).size,
    ).toBe(1);
    expect(server.submissions.size).toBe(1);
    expect(panel.card()).not.toContain("Message not sent");
    await vi.waitFor(() =>
      expect(panel.userRows("Rename-safe message")).toBe(1),
    );
    await panel.close();
  });

  it("recovers the first send's 409 dance, a lost response, and Retry as one submission", async () => {
    const server = createAgentServer({ exists: true });
    // The person sends before history arrives, so the instance is unknown.
    server.holdHistory(true);
    const panel = await open(server);
    // The create-only send meets the instance (a real 409), the uid send
    // commits and its response is lost, and the network stays down.
    server.faults.send.push("drop-response-and-disconnect");
    await panel.send("First follow-up");
    await panel.settled();
    await vi.waitFor(() => expect(panel.card()).toContain("Message not sent"));
    expect(server.submissions.size).toBe(1);
    // A person sees the failure no sooner than the frame that also renders
    // Flue's failed send.
    await panel.frames();

    server.reconnect();
    server.holdHistory(false);
    const retry = [
      ...panel.container.querySelectorAll<HTMLButtonElement>(
        ".thread-error-card button",
      ),
    ].find((button) => button.textContent?.includes("Retry"));
    await React.act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(panel.card()).toBe(""));
    expect(server.submissions.size).toBe(1);
    const retried = server.sends().at(-1)?.body;
    expect(retried).not.toHaveProperty("initialData");
    expect(retried?.uid).not.toBe(null);
    await vi.waitFor(() => expect(panel.userRows("First follow-up")).toBe(1));
    await panel.close();
  });
});

describe("a refused message says why and comes back to the composer", () => {
  it.each([
    {
      reason: "archived Thread",
      status: 409,
      body: {
        status: "error",
        data: {
          code: "THREAD_ARCHIVED",
          message: "Thread is archived. Unarchive it before continuing.",
        },
      },
      text: "This thread is archived. Unarchive it to send messages.",
    },
    {
      reason: "workspace policy",
      status: 403,
      body: {
        status: "error",
        data: {
          code: "WORKSPACE_POLICY_DENIED",
          message: "Workspace policy does not allow this action.",
          reason: "runner_profile_maintenance",
        },
      },
      text: "Workspace policy doesn't allow this message to run.",
    },
    {
      reason: "Flue's chat length limit",
      status: 400,
      body: {
        error: {
          type: "invalid_request",
          message: "Request is malformed.",
          details: "A chat message must be at most 32000 characters.",
        },
      },
      text: "A chat message must be at most 32000 characters.",
    },
  ])("$reason", async ({ status, body, text }) => {
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();
    server.faults.send.push({ status, body });

    await panel.send("Refused message");
    await panel.settled();

    await vi.waitFor(() => expect(panel.card()).toContain(text));
    expect(panel.card()).not.toContain("Check your connection.");
    expect(panel.textarea().value).toBe("Refused message");
    expect(panel.userRows("Refused message")).toBe(0);
    expect(server.lookups()).toHaveLength(0);
    expect(server.sends()).toHaveLength(1);
    await panel.close();
  });
});

it("shows a refusal's reason over an earlier message's Retry card", async () => {
  const server = createAgentServer({ exists: true });
  const panel = await open(server);
  await panel.historyLoaded();
  server.faults.send.push("offline", "offline", "offline");
  server.faults.admission.push("offline", "offline", "offline");
  await panel.send("Lost on the way");
  await panel.settled();
  await vi.waitFor(() =>
    expect(panel.card()).toContain("Check your connection."),
  );

  server.faults.send.push({
    status: 409,
    body: { status: "error", data: { code: "THREAD_ARCHIVED", message: "" } },
  });
  await panel.send("Refused message");
  await panel.settled();

  await vi.waitFor(() =>
    expect(panel.card()).toContain("This thread is archived."),
  );
  expect(panel.textarea().value).toBe("Refused message");
  // The edited message replaced the one that was lost on the way.
  expect(panel.userRows("Lost on the way")).toBe(0);
  await panel.close();
});

describe("first follow-up cost", () => {
  it("sends one request when history shows the instance exists", async () => {
    const server = createAgentServer({ exists: true });
    const panel = await open(server);
    await panel.historyLoaded();

    await panel.send("Next step");
    await panel.settled();

    await vi.waitFor(() => expect(panel.userRows("Next step")).toBe(1));
    expect(server.sends()).toHaveLength(1);
    expect(server.sends()[0]?.body).not.toHaveProperty("initialData");
    await panel.close();
  });

  it("still creates an absent instance with its initial data", async () => {
    const server = createAgentServer({ exists: false });
    const panel = await open(server);

    await panel.send("Hello");
    await panel.settled();

    expect(server.sends()).toHaveLength(1);
    expect(server.sends()[0]?.body).toMatchObject({
      uid: null,
      initialData: agentInitialization,
    });
    expect(server.submissions.size).toBe(1);
    await panel.close();
  });
});
