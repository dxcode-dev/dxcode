import { sendRefusal } from "../threads/send-refusal.js";
import type { PendingSubmissionControl } from "../threads/thread-session-registry.js";
import {
  attachmentsUploading,
  messageWithAttachments,
} from "./message-attachments.js";
import {
  disposeAttachments,
  type PendingAttachment,
  type PendingAttachmentCollection,
} from "./pending-attachments.js";

/**
 * Sending a message in a Thread. The composer's message stays put, read-only,
 * until the server has it: a refusal or a lost connection leaves it as it
 * was, and an unedited resend reuses its idempotency key, so a message is
 * never lost and never sent twice. The UI keeps the state (`state`) and the
 * guards (`inFlight`, `generation`) and passes them in on each call.
 */

/** Who a message is for: the agent, or the people in a shared Thread. */
export type SendMode = "agent" | "chat";

/** A send the UI shows as a card above the composer. */
export interface SendIssue {
  readonly id: "action:send" | "action:send-refused" | "action:stop";
  readonly title: string;
  readonly message: string;
  readonly action: "none";
}

/** A send whose admission receipt never arrived, as Flue's session keeps it. */
export interface AdmissionFailedSend {
  readonly id: string;
  readonly message: string;
  /** Transport uncertainty keeps the key; a pre-input failure needs a new admission. */
  readonly retry: "transport" | "resend";
}

/** The parts of a Flue agent session a send uses. */
export interface AdmissionAgent {
  readonly failedSends: ReadonlyArray<AdmissionFailedSend>;
  readonly sendMessage: (message: string) => Promise<void>;
  readonly retrySend: (id: string) => Promise<void>;
  readonly resendPrompt: (id: string) => Promise<void>;
  readonly abort: () => Promise<void>;
}

export interface SendAdmissionState {
  readonly setAdmissionPending: (pending: boolean) => void;
  /** The latest send failed; the shown snapshot may still show its echo. */
  readonly setSendFailed: (failed: boolean) => void;
  /** A chat message being admitted has no run to stop. */
  readonly setAdmittingChat: (chat: boolean) => void;
  readonly setIssue: (issue: SendIssue | undefined) => void;
}

export interface SendAdmissionContext {
  /** The agent as the UI shows it, read when a step runs. */
  readonly agent: () => AdmissionAgent;
  /** A send is being admitted; another waits. */
  readonly inFlight: { current: boolean };
  /** Bumped by Stop, so an admission started before it does not send. */
  readonly generation: { current: number };
  /** A new Thread's first message is still being admitted. */
  readonly submissionPending: boolean;
  readonly submissionControl: PendingSubmissionControl;
  readonly collection: PendingAttachmentCollection;
  readonly setAttachments: (
    attachments: ReadonlyArray<PendingAttachment>,
  ) => void;
  readonly draft: {
    readonly get: () => string;
    readonly set: (value: string) => void;
  };
  readonly state: SendAdmissionState;
  readonly onSubmissionPendingChange?: (pending: boolean) => void;
  /** The server refused for access: the Thread's sharing changed. */
  readonly onAccessChanged?: () => void;
  /** A message reached the server, in its mode. */
  readonly onSent?: (mode: SendMode) => void;
}

/** A shared Thread's owner ended multiplayer or revoked Contribute. */
export const isReadOnlyRejection = (cause: unknown) =>
  cause instanceof Error &&
  "status" in cause &&
  cause.status === 403 &&
  "body" in cause &&
  typeof cause.body === "object" &&
  cause.body !== null &&
  "data" in cause.body &&
  typeof cause.body.data === "object" &&
  cause.body.data !== null &&
  "code" in cause.body.data &&
  cause.body.data.code === "THREAD_READ_ONLY";

const finishAdmission = (context: SendAdmissionContext) => {
  context.inFlight.current = false;
  context.submissionControl.setStopRequested(false);
  context.onSubmissionPendingChange?.(false);
  context.state.setAdmissionPending(false);
};

/** Stops the agent's run; says so when the request fails. */
export const stopAgent = async (context: SendAdmissionContext) => {
  try {
    await context.agent().abort();
  } catch {
    context.state.setIssue({
      id: "action:stop",
      title: "Could not stop",
      message: "Check your connection.",
      action: "none",
    });
  }
};

/** Stop: also stops a run whose message is still being admitted. */
export const stopSend = async (context: SendAdmissionContext) => {
  context.generation.current += 1;
  if (context.inFlight.current || context.submissionPending)
    context.submissionControl.setStopRequested(true);
  await stopAgent(context);
};

/**
 * Holds the composer's message, read-only, while `deliver` sends a message,
 * and lets go of it only once the server has that message. `deliver` gets
 * the composer's message with its attachments and returns the one it sent.
 * A refusal or a lost connection leaves the composer as it was.
 */
export const admitSend = (
  context: SendAdmissionContext,
  mode: SendMode,
  text: string,
  deliver: (held: string) => Promise<string>,
) => {
  if (context.inFlight.current || context.submissionPending)
    return Promise.resolve();
  context.inFlight.current = true;
  context.submissionControl.setStopRequested(false);
  context.onSubmissionPendingChange?.(true);
  const generation = ++context.generation.current;
  context.state.setAdmittingChat(mode === "chat");
  context.state.setAdmissionPending(true);
  context.state.setSendFailed(false);
  context.state.setIssue(undefined);
  const runAdmission = async () => {
    try {
      await context.collection.settle();
      if (generation !== context.generation.current) return;
      const held = await messageWithAttachments(
        text,
        context.collection.list(),
      );
      const sent = await deliver(held);
      context.onSent?.(mode);
      if (context.submissionControl.stopRequested()) await stopAgent(context);
      if (sent === held) {
        context.draft.set("");
        disposeAttachments(context.collection.take());
        context.setAttachments([]);
      }
    } catch (cause) {
      // A refused message stays in the composer with its reason. One the
      // server may hold stays there too, and in Flue's failed send, whose
      // key an unedited Send or Retry reuses, so it cannot duplicate.
      const refusal = sendRefusal(cause);
      if (isReadOnlyRejection(cause)) context.onAccessChanged?.();
      context.state.setSendFailed(true);
      context.state.setIssue({
        // A Retry card for a failed send replaces only the generic error.
        id: refusal === undefined ? "action:send" : "action:send-refused",
        title: "Message not sent",
        message: refusal ?? "Check your connection.",
        action: "none",
      });
    }
  };
  return runAdmission().finally(() => finishAdmission(context));
};

/** Sends a failed send again: under its key, or as a new admission. */
export const deliverFailedSend = (
  agent: AdmissionAgent,
  failed: AdmissionFailedSend,
) =>
  failed.retry === "resend"
    ? agent.resendPrompt(failed.id)
    : agent.retrySend(failed.id);

/**
 * Send: refuses a message with a failed upload, or a chat message with
 * files, and otherwise admits it. Unedited since it failed, it goes again
 * under its key; edited, the new message replaces the failed one.
 */
export const submitSend = async (
  context: SendAdmissionContext,
  {
    draft,
    mode,
    attachments,
    discardSends,
  }: {
    readonly draft: string;
    readonly mode: SendMode;
    /** The composer's files as shown. */
    readonly attachments: ReadonlyArray<PendingAttachment>;
    /** Failed sends an edited message replaced; Flue has no discard. */
    readonly discardSends: (ids: ReadonlyArray<string>) => void;
  },
) => {
  const message = draft.trim();
  if (
    context.inFlight.current ||
    context.submissionPending ||
    (!message && attachments.length === 0) ||
    attachmentsUploading(attachments)
  )
    return;
  const failedUpload = attachments.find(
    ({ upload }) => upload.getSnapshot().status === "failed",
  );
  if (failedUpload !== undefined) {
    context.state.setIssue({
      id: "action:send",
      title: "Message not sent",
      message: `${failedUpload.filename} did not upload. Remove it and attach it again.`,
      action: "none",
    });
    return;
  }
  if (mode === "chat" && attachments.length > 0) {
    context.state.setIssue({
      id: "action:send",
      title: "Message not sent",
      message: "Chat messages can't include attachments. Tag @dx to send them.",
      action: "none",
    });
    return;
  }
  await admitSend(context, mode, message, async (held) => {
    // Unedited since it failed: send it under its key again. Edited: the
    // new message replaces the failed one.
    const agent = context.agent();
    const failed = agent.failedSends.findLast(
      ({ message: sent }) => sent === held,
    );
    if (failed !== undefined) await deliverFailedSend(agent, failed);
    else {
      discardSends(agent.failedSends.map(({ id }) => id));
      await agent.sendMessage(held);
    }
    return held;
  });
};

/** The failed-send card's Retry; clears the composer if it held that one. */
export const retryFailedSend = (
  context: SendAdmissionContext,
  failed: AdmissionFailedSend,
  mode: SendMode,
) =>
  admitSend(context, mode, context.draft.get().trim(), async () => {
    await deliverFailedSend(context.agent(), failed);
    return failed.message;
  });
