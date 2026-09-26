import type { ThreadId } from "@dx/domain";
import { Data, Option, Schema } from "effect";
import {
  DXD_PROTOCOL_MAJOR,
  DXD_RELEASE,
  type DxdChangesRefresh,
  type DxdFilesListOperation,
  DxdFilesListResult,
  DxdFilesOperation,
  type DxdFilesReadOperation,
  DxdFilesReadResult,
  type DxdFilesSaveOperation,
  DxdFilesSaveResult,
} from "../execution/dxd/protocol.js";
import type { Bindings } from "../http/types.js";

const ActivationMilestoneTimestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);

export const DaemonActivationMilestones = Schema.Struct({
  releaseLoadedAt: ActivationMilestoneTimestamp,
  installedAt: ActivationMilestoneTimestamp,
  connectedAt: ActivationMilestoneTimestamp,
  environmentReadyAt: ActivationMilestoneTimestamp,
});
export type DaemonActivationMilestones = typeof DaemonActivationMilestones.Type;

export const DaemonActivationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/),
);

export const DaemonActivationStarted = Schema.Struct({
  ready: Schema.Literal(false),
  activationId: DaemonActivationId,
});
export type DaemonActivationStarted = typeof DaemonActivationStarted.Type;

export const DaemonReadiness = Schema.Struct({
  ready: Schema.Literal(true),
  activationId: DaemonActivationId,
  release: Schema.Literal(DXD_RELEASE),
  protocolMajor: Schema.Literal(DXD_PROTOCOL_MAJOR),
  activationMilestones: Schema.optional(DaemonActivationMilestones),
});
export type DaemonReadiness = typeof DaemonReadiness.Type;

export const DaemonFailureOutcome = Schema.Literals(["known", "unknown"]);
export type DaemonFailureOutcome = typeof DaemonFailureOutcome.Type;

export const DaemonFailureResponse = Schema.Struct({
  error: Schema.Literal("daemon-unavailable"),
  outcome: DaemonFailureOutcome,
});

export class DaemonUnavailable extends Data.TaggedError("DaemonUnavailable")<{
  readonly message: "Thread daemon is unavailable.";
  readonly outcome: DaemonFailureOutcome;
}> {}

export const daemonFailureResponse = (outcome: DaemonFailureOutcome) =>
  Response.json({ error: "daemon-unavailable", outcome }, { status: 503 });

const unavailable = (outcome: DaemonFailureOutcome) =>
  new DaemonUnavailable({
    message: "Thread daemon is unavailable.",
    outcome,
  });

export const residentThreadDaemonEndpoint = (
  publicUrl: string,
  threadId: ThreadId,
) => {
  try {
    const endpoint = new URL(publicUrl);
    if (
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      endpoint.pathname !== "/"
    )
      return undefined;
    if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
    else if (
      endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
      endpoint.protocol = "ws:";
    else return undefined;
    endpoint.pathname = `/v1/threads/${encodeURIComponent(threadId)}/dxd`;
    return endpoint.toString();
  } catch {
    return undefined;
  }
};

export const activateThreadDaemon = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
): Promise<DaemonReadiness> => {
  try {
    const namespace = bindings.THREAD_EXECUTION;
    if (namespace === undefined) throw new Error("binding unavailable");
    const response = await namespace
      .get(namespace.idFromName(threadId))
      .fetch("https://thread.internal/daemon/activate", {
        method: "POST",
        headers: {
          "x-dx-daemon-activate": "1",
          "x-dx-thread-id": threadId,
        },
      });
    if (!response.ok) throw new Error("activation failed");
    return Schema.decodeUnknownSync(DaemonReadiness)(await response.json());
  } catch {
    throw unavailable("known");
  }
};

export const startThreadDaemonActivation = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  submissionId?: string,
): Promise<DaemonActivationStarted | undefined> => {
  try {
    const namespace = bindings.THREAD_EXECUTION;
    if (namespace === undefined) return undefined;
    const response = await namespace
      .get(namespace.idFromName(threadId))
      .fetch("https://thread.internal/daemon/activate", {
        method: "POST",
        headers: {
          "x-dx-daemon-activate": "1",
          "x-dx-daemon-activate-mode": "background",
          "x-dx-thread-id": threadId,
          ...(submissionId === undefined
            ? {}
            : { "x-dx-submission-id": submissionId }),
        },
      });
    if (response.status !== 202) return undefined;
    return Schema.decodeUnknownSync(DaemonActivationStarted)(
      await response.json(),
    );
  } catch {
    return undefined;
  }
};

export const queueThreadChangesRefresh = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  refresh: DxdChangesRefresh,
) => {
  try {
    const namespace = bindings.THREAD_EXECUTION;
    if (namespace === undefined) return false;
    const response = await namespace
      .get(namespace.idFromName(threadId))
      .fetch("https://thread.internal/changes/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dx-changes-refresh": "1",
          "x-dx-thread-id": threadId,
        },
        body: JSON.stringify(refresh),
      });
    return response.ok;
  } catch {
    return false;
  }
};

export function requestThreadDaemon(
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  operation: DxdFilesListOperation,
): Promise<typeof DxdFilesListResult.Type>;
export function requestThreadDaemon(
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  operation: DxdFilesReadOperation,
): Promise<typeof DxdFilesReadResult.Type>;
export function requestThreadDaemon(
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  operation: DxdFilesSaveOperation,
): Promise<typeof DxdFilesSaveResult.Type>;
export async function requestThreadDaemon(
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  operation:
    | DxdFilesListOperation
    | DxdFilesReadOperation
    | DxdFilesSaveOperation,
) {
  let body: string;
  try {
    body = JSON.stringify(
      Schema.encodeUnknownSync(DxdFilesOperation)(operation),
    );
  } catch {
    throw unavailable("known");
  }
  try {
    const namespace = bindings.THREAD_EXECUTION;
    if (namespace === undefined) throw new Error("binding unavailable");
    const response = await namespace
      .get(namespace.idFromName(threadId))
      .fetch("https://thread.internal/daemon/request", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dx-daemon-request": "1",
          "x-dx-thread-id": threadId,
        },
        body,
      });
    if (!response.ok) {
      const failure = Schema.decodeUnknownOption(DaemonFailureResponse)(
        await response.json().catch(() => undefined),
      );
      throw Option.isSome(failure)
        ? unavailable(failure.value.outcome)
        : unavailable("unknown");
    }
    const result = await response.json();
    switch (operation.operation) {
      case "files.list":
        return Schema.decodeUnknownSync(DxdFilesListResult)(result);
      case "files.read":
        return Schema.decodeUnknownSync(DxdFilesReadResult)(result);
      case "files.save":
        return Schema.decodeUnknownSync(DxdFilesSaveResult)(result);
    }
  } catch (cause) {
    if (cause instanceof DaemonUnavailable) throw cause;
    throw unavailable("unknown");
  }
}

export const drainThreadDaemon = async (
  bindings: Pick<Bindings, "THREAD_EXECUTION">,
  threadId: ThreadId,
  reason:
    | "thread-archived"
    | "workspace-paused"
    | "thread-deleted"
    | "workspace-lost",
) => {
  try {
    const namespace = bindings.THREAD_EXECUTION;
    if (namespace === undefined) throw new Error("binding unavailable");
    const response = await namespace
      .get(namespace.idFromName(threadId))
      .fetch("https://thread.internal/daemon/drain", {
        method: "POST",
        headers: {
          "x-dx-daemon-drain": "1",
          "x-dx-daemon-drain-reason": reason,
          "x-dx-thread-id": threadId,
        },
      });
    if (!response.ok) throw new Error("drain failed");
  } catch {
    throw unavailable("unknown");
  }
};
