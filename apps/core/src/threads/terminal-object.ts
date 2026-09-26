import { DurableObject } from "cloudflare:workers";
import {
  THREAD_CHANGES_SUBPROTOCOL,
  THREAD_TERMINAL_SUBPROTOCOL,
  type ThreadTerminalServerPhase,
} from "@dx/api";
import { ThreadId, WorkloadIdentityUnauthorized } from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import {
  mintThreadDaemonApiKey,
  revokeThreadDaemonApiKey,
} from "../auth/daemon-api-key.js";
import {
  type DaemonGeneration,
  DaemonGeneration as DaemonGenerationSchema,
  DXD_HEARTBEAT_INTERVAL_MS,
  DXD_HEARTBEAT_LEASE_MS,
  DXD_MAX_CHANGES_CANDIDATE_BYTES,
  DXD_MAX_CLIENT_FRAME_BYTES,
  DXD_MAX_CONTROL_FRAME_BYTES,
  DXD_MAX_ENVIRONMENT_REQUEST_FRAME_BYTES,
  DXD_MAX_REQUEST_FRAME_BYTES,
  DXD_MAX_RESPONSE_FRAME_BYTES,
  DXD_MAX_WORKLOAD_IDENTITY_FRAME_BYTES,
  DXD_PROTOCOL_MAJOR,
  DXD_RELEASE,
  DXD_TERMINAL_MAX_FRAME_BYTES,
  DXD_TERMINAL_SEND_BUFFER_BYTES,
  DXD_TERMINAL_VERSION,
  DXD_WORKLOAD_IDENTITY_VERSION,
  type DxdChangesCandidateEvent,
  DxdChangesCandidateMessage,
  type DxdChangesRefresh,
  DxdChangesRefreshMessage,
  DxdClientControlMessage,
  type DxdClientTerminalControl,
  type DxdCoreTerminalControl,
  DxdEnvironmentActivateResult,
  DxdFilesOperation,
  type DxdOperation,
  DxdResponseEnvelope,
  type DxdTerminalHeartbeat,
  type DxdWorkloadIdentityRequest,
  DxdWorkloadIdentityRequestMessage,
} from "../execution/dxd/protocol.js";
import {
  ExecutionWorkspaces,
  sourceWorkspaceLayer,
} from "../execution/execution-workspaces.js";
import type { Bindings } from "../http/types.js";
import { threadDaemonLogger } from "../logging.js";
import {
  StartupRequestId,
  StartupSubmissionId,
  StartupTraceCorrelation,
} from "../observability/startup-phase.js";
import {
  recordStartupPhases,
  startupObservation,
  startupServerTiming,
} from "../observability/startup-runtime.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { publishRealtimeInvalidation } from "../realtime/publication.js";
import { loadRuntimeConfiguration } from "../runtime/composition.js";
import { environmentActivationOperation } from "../settings/environment-variables/activation.js";
import {
  executionEnvironmentRevisionsEqual,
  resolveExecutionEnvironment,
  resolveExecutionEnvironmentRevision,
} from "../settings/environment-variables/execution.js";
import { resolveExecutionSigningPlan } from "../settings/keys/execution.js";
import { signGitPayload } from "../settings/keys/ssh-ed25519.js";
import { SourceRuntimeBroker } from "../source-control/runtime.js";
import {
  makeResidentThreadChangesTerminalObserver,
  runResidentThreadChangesMutation,
  type ThreadChangesTerminalObserver,
} from "../thread-changes/coordinator.js";
import { makeThreadChangesRepository } from "../thread-changes/repository-d1.js";
import { publishThreadChangesResidentCandidate } from "../thread-changes/resident-publisher.js";
import { workloadIdentityBroker } from "../workload-identity/broker.js";
import {
  type DaemonActivationMilestones,
  DaemonReadiness,
  daemonFailureResponse,
  residentThreadDaemonEndpoint,
} from "./daemon-client.js";
import {
  type ResidentTerminalMetadata,
  ResidentTerminalRelay,
  type ResidentTerminalTransport,
} from "./resident-terminal-relay.js";

const ACTIVATION_TIMEOUT_MS = 30_000;
const TRANSIENT_ACTIVATION_RETRY_MS = 250;
export const DAEMON_ACTIVATION_DEADLINE_MS = 90_000;
export const DAEMON_ACTIVATION_GRACE_MS = 90_000;
const DAEMON_REQUEST_TIMEOUT_MS = 5_000;
const READINESS_PROBE_TIMEOUT_MS = 1_000;
const MAX_PENDING_DAEMON_REQUESTS = 32;
const gitCommitIdentity = /^(.+) <([^<>\r\n]+)> \d+ [+-]\d{4}$/;

/**
 * Accept only the unsigned header grammar Git gives an SSH signing program.
 * In particular, do not infer a commit from identities found in arbitrary
 * data: the managed signer must never become a general-purpose signing oracle.
 */
export const nativeGitCommitIdentities = (text: string) => {
  const end = text.indexOf("\n\n");
  if (end < 0) return undefined;
  const lines = text.slice(0, end).split("\n");
  if (!/^tree [0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(lines[0] ?? ""))
    return undefined;

  let index = 1;
  while (/^parent [0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(lines[index] ?? ""))
    index += 1;
  const author =
    lines[index]?.match(/^author (.+)$/)?.[1].match(gitCommitIdentity) ??
    undefined;
  if (author === undefined) return undefined;
  index += 1;
  const committer =
    lines[index]?.match(/^committer (.+)$/)?.[1].match(gitCommitIdentity) ??
    undefined;
  if (committer === undefined) return undefined;
  index += 1;

  let mergetagOpen = false;
  let mergetagHasContinuation = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith(" ")) {
      if (!mergetagOpen) return undefined;
      mergetagHasContinuation = true;
      continue;
    }
    // These are the optional headers Git can emit before it asks its signing
    // program to sign an otherwise unsigned commit object. gpgsig is excluded:
    // a payload already carrying a signature is not an unsigned commit.
    if (/^encoding [^\s]+$/.test(line)) {
      if (mergetagOpen && !mergetagHasContinuation) return undefined;
      mergetagOpen = false;
      continue;
    }
    if (
      /^mergetag object [0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line) &&
      (!mergetagOpen || mergetagHasContinuation)
    ) {
      mergetagOpen = true;
      mergetagHasContinuation = false;
      continue;
    }
    return undefined;
  }
  if (mergetagOpen && !mergetagHasContinuation) return undefined;
  return { author, committer };
};
const MAX_PENDING_WORKLOAD_IDENTITY_REQUESTS = 32;
const HEARTBEAT_PERSIST_INTERVAL_MS = 10_000;
const AUTHORITY_STORAGE_KEY = "daemon-authority";
const ACTIVATION_ATTEMPT_STORAGE_KEY = "daemon-activation-attempt";
const ENVIRONMENT_GENERATION_STORAGE_KEY = "environment-next-generation";
const APPLIED_ENVIRONMENT_STORAGE_KEY = "environment-applied";

const EnvironmentRevision = Schema.Struct({
  personal: Schema.Struct({
    targetId: Schema.String,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  project: Schema.Struct({
    targetId: Schema.String,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  workspace: Schema.Struct({
    targetId: Schema.NullOr(Schema.String),
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});

const AppliedEnvironmentMarker = Schema.Struct({
  version: Schema.Literal(1),
  daemonGeneration: DaemonGenerationSchema,
  connectionNonce: Schema.String,
  appliedGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  revisions: EnvironmentRevision,
});
type AppliedEnvironmentMarker = typeof AppliedEnvironmentMarker.Type;

const DaemonActivationObservation = Schema.Struct({
  submissionId: Schema.Union([StartupSubmissionId, Schema.Literal("")]),
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type DaemonActivationObservation = typeof DaemonActivationObservation.Type;

const DaemonActivationAttempt = Schema.Struct({
  activationId: StartupRequestId,
  threadId: ThreadId,
  deadlineAt: Schema.Int.check(Schema.isGreaterThan(0)),
  submissions: Schema.Array(DaemonActivationObservation),
});
type DaemonActivationAttempt = typeof DaemonActivationAttempt.Type;

const LegacyDaemonActivationAttempt = Schema.Struct({
  activationId: StartupRequestId,
  threadId: ThreadId,
  submissionId: StartupSubmissionId,
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deadlineAt: Schema.Int.check(Schema.isGreaterThan(0)),
});

interface DaemonActivation {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly startedAt: number;
  readonly response: Promise<Response>;
  readonly work: Promise<Response>;
  retained: Promise<void>;
  readonly observations: Map<string, DaemonActivationObservation>;
  persistence: Promise<void>;
  retainedByContext: boolean;
}

interface DaemonActivationTimingObservation {
  readonly submissionId: string;
  readonly startedAt: number;
}

interface DaemonAuthority {
  readonly threadId: string;
  readonly generation: DaemonGeneration;
  readonly apiKeyId: string;
  readonly release: typeof DXD_RELEASE;
  readonly protocolMajor: typeof DXD_PROTOCOL_MAJOR;
  readonly terminalVersion: typeof DXD_TERMINAL_VERSION;
  readonly workloadIdentityVersion: typeof DXD_WORKLOAD_IDENTITY_VERSION;
  readonly runtimeProvider: "local" | "e2b";
  readonly runtimeAssurance: "dx_dxd_channel_v1" | "dx_provider_attested_v1";
  readonly attachmentNonce?: string;
  readonly lastSeen?: number;
}

interface DaemonAttachment {
  readonly kind: "daemon";
  readonly generation?: DaemonGeneration;
  readonly nonce?: string;
  readonly terminal?: DxdTerminalHeartbeat;
}

interface ResidentBrowserAttachment {
  readonly kind: "resident-browser";
  readonly threadId: ThreadId;
  readonly daemonGeneration?: DaemonGeneration;
  readonly nonce?: string;
  readonly terminal: ResidentTerminalMetadata;
}

interface ChangesBrowserAttachment {
  readonly kind: "changes-browser";
  readonly threadId: ThreadId;
}

type SocketAttachment =
  | DaemonAttachment
  | ResidentBrowserAttachment
  | ChangesBrowserAttachment;

interface PendingDaemonRequest {
  readonly authority: Pick<DaemonAuthority, "threadId" | "generation">;
  readonly operation: DxdOperation;
  readonly maximumBytes: number;
  readonly resumable: boolean;
  readonly deadline: number;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (response: Response) => void;
  socket?: WebSocket;
  dispatched: boolean;
}

const randomBase64Url = (byteLength: number) => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const boundedTimestamp = (value: string | null) => {
  if (value === null || !/^\d{13}$/.test(value)) return undefined;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
};

const boundedDuration = (value: string | null) => {
  if (value === null || !/^\d{1,8}$/.test(value)) return undefined;
  const duration = Number(value);
  return Number.isSafeInteger(duration) ? duration : undefined;
};

const isTerminalControl = (
  control: typeof DxdClientControlMessage.Type,
): control is DxdClientTerminalControl => control.type.startsWith("terminal.");

export class ThreadExecutionObject extends DurableObject<Bindings> {
  readonly #residentRelay = new ResidentTerminalRelay();
  #authority?: DaemonAuthority;
  #activation?: DaemonActivation;
  #activationId?: string;
  #drainEpoch = 0;
  #readinessProbe?: {
    readonly socket: WebSocket;
    readonly generation: DaemonGeneration;
    readonly nonce: string;
    readonly requestId: string;
    readonly deadline: number;
    readonly settle: (
      result: "ready" | "changed" | "timeout" | "drained",
    ) => void;
  };
  #connectionRecovery?: Promise<void>;
  #connectionRecoveryWake?: (reason: "registered" | "activated") => void;
  #repair?: Promise<void>;
  #environmentReady = false;
  #nextEnvironmentGeneration = 1;
  #environmentActivation?: Promise<void>;
  #environmentDirty = false;
  #appliedEnvironment?: AppliedEnvironmentMarker;
  #terminalHeartbeat?: DxdTerminalHeartbeat;
  #lastPersistedHeartbeatAt?: number;
  #terminalResetRequired = false;
  readonly #readinessWaiters = new Set<() => void>();
  readonly #terminalWaiters = new Set<(state: DxdTerminalHeartbeat) => void>();
  readonly #pendingRequests = new Map<string, PendingDaemonRequest>();
  readonly #pendingWorkloadIdentityRequests = new Set<string>();
  #residentChanges?: ThreadChangesTerminalObserver;
  #observingChanges?: Promise<void>;
  #changesObserved = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.#authority = await ctx.storage.get<DaemonAuthority>(
        AUTHORITY_STORAGE_KEY,
      );
      this.#lastPersistedHeartbeatAt = this.#authority?.lastSeen;
      const storedEnvironmentGeneration = await ctx.storage.get<number>(
        ENVIRONMENT_GENERATION_STORAGE_KEY,
      );
      if (
        Number.isSafeInteger(storedEnvironmentGeneration) &&
        (storedEnvironmentGeneration as number) >= 1
      )
        this.#nextEnvironmentGeneration = storedEnvironmentGeneration as number;
      const storedAppliedEnvironment = Schema.decodeUnknownOption(
        AppliedEnvironmentMarker,
      )(await ctx.storage.get(APPLIED_ENVIRONMENT_STORAGE_KEY));
      this.#appliedEnvironment = Option.isSome(storedAppliedEnvironment)
        ? storedAppliedEnvironment.value
        : undefined;
      let authority = this.#authority;
      const expectedAuthority = authority;
      const daemonSocket =
        expectedAuthority === undefined
          ? undefined
          : ctx.getWebSockets().find((candidate) => {
              const daemon = candidate.deserializeAttachment() as
                | DaemonAttachment
                | undefined;
              return (
                daemon?.kind === "daemon" &&
                daemon.generation === expectedAuthority.generation &&
                daemon.nonce === expectedAuthority.attachmentNonce
              );
            });
      const daemonAttachment = daemonSocket?.deserializeAttachment() as
        | DaemonAttachment
        | undefined;
      if (
        authority?.lastSeen !== undefined &&
        daemonSocket !== undefined &&
        Date.now() - authority.lastSeen <=
          DXD_HEARTBEAT_LEASE_MS + HEARTBEAT_PERSIST_INTERVAL_MS
      ) {
        authority = { ...authority, lastSeen: Date.now() };
        this.#authority = authority;
      }
      const marker = this.#appliedEnvironment;
      if (
        authority?.attachmentNonce !== undefined &&
        authority.lastSeen !== undefined &&
        Date.now() - authority.lastSeen <= DXD_HEARTBEAT_LEASE_MS &&
        daemonAttachment?.terminal !== undefined &&
        marker?.daemonGeneration === authority.generation &&
        marker.connectionNonce === authority.attachmentNonce
      ) {
        try {
          const currentRevision = await Effect.runPromise(
            resolveExecutionEnvironmentRevision(env, authority.threadId),
          );
          if (
            executionEnvironmentRevisionsEqual(
              marker.revisions,
              currentRevision,
            )
          ) {
            this.#environmentReady = true;
            this.#terminalHeartbeat = daemonAttachment.terminal;
          }
        } catch {
          // A wake without a current revision proof must reactivate normally.
        }
      }
      if (!this.#environmentReady && this.#appliedEnvironment !== undefined) {
        this.#appliedEnvironment = undefined;
        await ctx.storage.delete(APPLIED_ENVIRONMENT_STORAGE_KEY);
      }
      for (const socket of ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as
          | SocketAttachment
          | undefined;
        if (attachment?.kind !== "resident-browser") continue;
        const daemonConnected =
          authority !== undefined && daemonSocket !== undefined;
        const fenced =
          !attachment.terminal.requested ||
          (authority !== undefined &&
            authority.threadId === attachment.threadId &&
            authority.generation === attachment.daemonGeneration &&
            authority.release === DXD_RELEASE &&
            authority.protocolMajor === DXD_PROTOCOL_MAJOR &&
            authority.terminalVersion === DXD_TERMINAL_VERSION &&
            authority.workloadIdentityVersion ===
              DXD_WORKLOAD_IDENTITY_VERSION &&
            authority.attachmentNonce !== undefined &&
            authority.attachmentNonce === attachment.nonce &&
            authority.lastSeen !== undefined &&
            Date.now() - authority.lastSeen <= DXD_HEARTBEAT_LEASE_MS &&
            daemonConnected);
        if (
          !fenced ||
          !this.#residentRelay.restore(
            socket,
            attachment.terminal,
            this.#residentTransport(attachment.threadId, () => {}, socket),
          )
        )
          this.#closeResidentBrowserForReconnect(socket);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/daemon/activate") return this.#activate(request);
    if (path === "/daemon/request") return this.#requestDaemon(request);
    if (path === "/daemon/drain") return this.#drainDaemon(request);
    if (path === "/daemon/socket") return this.#acceptDaemon(request);
    if (path === "/environment/refresh")
      return this.#refreshEnvironment(request);
    if (path === "/changes/refresh") return this.#queueChangesRefresh(request);
    if (path === "/changes/events") return this.#acceptChangesObserver(request);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 404 });
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      request.headers.get("x-dx-thread-id"),
    );
    if (Option.isNone(threadId)) return new Response(null, { status: 404 });
    const requestId = Schema.decodeUnknownOption(StartupRequestId)(
      request.headers.get("x-dx-request-id"),
    );
    const startedAt = boundedTimestamp(request.headers.get("x-dx-started-at"));
    const admittedDuration = boundedDuration(
      request.headers.get("x-dx-admitted-duration"),
    );
    const authenticatedDuration = boundedDuration(
      request.headers.get("x-dx-authenticated-duration"),
    );
    const authorizedDuration = boundedDuration(
      request.headers.get("x-dx-authorized-duration"),
    );
    if (
      Option.isNone(requestId) ||
      startedAt === undefined ||
      authenticatedDuration === undefined ||
      authorizedDuration === undefined ||
      admittedDuration === undefined ||
      authenticatedDuration > authorizedDuration ||
      authorizedDuration > admittedDuration
    )
      return new Response(null, { status: 404 });
    if (request.headers.get("x-dx-terminal-route") !== "resident")
      return new Response(null, { status: 404 });
    const correlation = Schema.decodeUnknownSync(StartupTraceCorrelation)({
      journey: "terminal",
      requestId: requestId.value,
      threadId: threadId.value,
    });
    const initialObservations = [
      startupObservation(correlation, "request_received", startedAt, startedAt),
      startupObservation(
        correlation,
        "authenticated",
        startedAt,
        startedAt + authenticatedDuration,
      ),
      startupObservation(
        correlation,
        "thread_authorized",
        startedAt,
        startedAt + authorizedDuration,
      ),
      startupObservation(
        correlation,
        "websocket_admitted",
        startedAt,
        startedAt + admittedDuration,
      ),
      startupObservation(correlation, "durable_object_reached", startedAt),
    ];
    const observed = new Set(initialObservations.map(({ phase }) => phase));
    let delivery = recordStartupPhases(this.env.DB, initialObservations);
    this.ctx.waitUntil(delivery);
    const record = (
      phase: ThreadTerminalServerPhase,
      outcome: "reached" | "failed" = "reached",
    ) => {
      if (observed.has(phase)) return;
      const observation = startupObservation(
        correlation,
        phase,
        startedAt,
        Date.now(),
        { outcome },
      );
      observed.add(phase);
      delivery = delivery.then(() =>
        recordStartupPhases(this.env.DB, [observation]),
      );
      this.ctx.waitUntil(delivery);
    };

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.#residentRelay.attach(
      server,
      this.#residentTransport(threadId.value, record, server),
      false,
    );
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        "Server-Timing": startupServerTiming(initialObservations),
        "Sec-WebSocket-Protocol": THREAD_TERMINAL_SUBPROTOCOL,
      },
    });
  }

  async alarm() {
    const attempt = await this.#readDaemonActivationAttempt();
    if (attempt === undefined) return;
    if (Date.now() < attempt.deadlineAt) {
      await this.ctx.storage.setAlarm(attempt.deadlineAt + 1_000);
      return;
    }
    if (
      this.#activation !== undefined &&
      this.#activation.id === attempt.activationId
    ) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    await Promise.all(
      attempt.submissions.map((observation) =>
        this.#recordDaemonActivationFailure(attempt, observation),
      ),
    );
    await Promise.all([
      this.ctx.storage.delete(ACTIVATION_ATTEMPT_STORAGE_KEY),
      this.ctx.storage.deleteAlarm(),
    ]);
  }

  #acceptChangesObserver(request: Request): Response {
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      request.headers.get("x-dx-thread-id"),
    );
    if (
      Option.isNone(threadId) ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("sec-websocket-protocol") !==
        THREAD_CHANGES_SUBPROTOCOL
    )
      return new Response(null, { status: 404 });
    if (
      this.ctx
        .getWebSockets()
        .filter(
          (socket) =>
            (socket.deserializeAttachment() as SocketAttachment | undefined)
              ?.kind === "changes-browser",
        ).length >= 16
    )
      return new Response(null, { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      kind: "changes-browser",
      threadId: threadId.value,
    } satisfies ChangesBrowserAttachment);
    // Initial notification closes the race between the HTTP read and subscription.
    pair[1].send(JSON.stringify({ type: "changes-updated" }));
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "Sec-WebSocket-Protocol": THREAD_CHANGES_SUBPROTOCOL },
    });
  }

  #notifyChanges(threadId: string) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as
        | SocketAttachment
        | undefined;
      if (
        attachment?.kind !== "changes-browser" ||
        attachment.threadId !== threadId
      )
        continue;
      try {
        socket.send(JSON.stringify({ type: "changes-updated" }));
      } catch {
        /* A disconnected observer recovers through its next HTTP read. */
      }
    }
  }

  #observeChanges(socket: WebSocket, threadId: ThreadId) {
    this.#changesObserved = true;
    if (this.#observingChanges !== undefined || this.env.DB === undefined)
      return;
    const db = this.env.DB;
    this.#observingChanges = (async () => {
      // Registration repairs the first durable capture. Do not advance its
      // generation underneath it, then exhaust publication retries on its lease.
      await this.#repair;
      while (this.#changesObserved && this.#currentDaemonSocket() === socket) {
        this.#changesObserved = false;
        let refresh: DxdChangesRefresh | undefined;
        await runResidentThreadChangesMutation({
          db,
          threadId,
          allowMissingSource: true,
          operation: async (value) => {
            refresh = value;
          },
        });
        if (refresh !== undefined && this.#currentDaemonSocket() === socket) {
          this.#notifyChanges(threadId);
          socket.send(JSON.stringify(refresh));
        }
      }
    })()
      .catch(() => {
        threadDaemonLogger.warn(
          "Changes observation could not request a capture.",
          {
            event: "thread_changes_observation_failed",
            threadId,
          },
        );
      })
      .finally(() => {
        this.#observingChanges = undefined;
      });
    this.ctx.waitUntil(this.#observingChanges);
  }

  async #publishChanges(
    socket: WebSocket,
    threadId: ThreadId,
    candidate: DxdChangesCandidateEvent,
  ) {
    if (this.env.DB === undefined || this.env.DX_STORAGE === undefined) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.#currentDaemonSocket() !== socket) return;
      const outcome = await publishThreadChangesResidentCandidate({
        db: this.env.DB,
        bucket: this.env.DX_STORAGE,
        threadId,
        candidate,
        onPublished: () =>
          publishRealtimeInvalidation(
            this.env,
            threadId,
            "changes.invalidated",
          ),
      });
      if (outcome === "published" || outcome === "unchanged") {
        this.#notifyChanges(threadId);
        return;
      }
      if (outcome === "superseded") {
        // Activation may supersede the observer's first token without queuing a
        // resident capture. Request fresh work, never replay the stale candidate.
        const repository = makeThreadChangesRepository(this.env.DB);
        const [state, source] = await Promise.all([
          repository.read(threadId),
          repository.source(threadId),
        ]);
        if (
          state?.dirtySince !== undefined &&
          state.refreshToken !== undefined &&
          source !== undefined &&
          this.#currentDaemonSocket() === socket
        ) {
          socket.send(
            JSON.stringify({
              type: "changes-refresh",
              token: state.refreshToken,
              source: {
                baseline: source.baseline,
                defaultBranch: source.defaultBranch,
              },
              ...(state.latestFingerprint === undefined
                ? {}
                : { expectedFingerprint: state.latestFingerprint }),
            } satisfies DxdChangesRefresh),
          );
        }
        return;
      }
      if (outcome !== "busy" && outcome !== "unavailable") return;
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  async #activate(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      request.headers.get("x-dx-daemon-activate") !== "1"
    )
      return new Response(null, { status: 404 });
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      request.headers.get("x-dx-thread-id"),
    );
    if (Option.isNone(threadId)) return new Response(null, { status: 404 });
    const submissionId = request.headers.get("x-dx-submission-id") ?? "";
    const requestedAt = Date.now();
    const activation = this.#activationForThread(threadId.value);
    if (request.headers.get("x-dx-daemon-activate-mode") === "background") {
      this.#retainDaemonActivation(activation);
      if (submissionId !== "" && !activation.observations.has(submissionId)) {
        const observation = Schema.decodeUnknownSync(
          DaemonActivationObservation,
        )({ submissionId, startedAt: requestedAt });
        activation.observations.set(submissionId, observation);
        const observed = this.#recordDaemonActivation(activation, observation);
        this.ctx.waitUntil(observed.catch(() => undefined));
      }
      return Response.json(
        { ready: false, activationId: activation.id },
        { status: 202 },
      );
    }
    return (await activation.response).clone();
  }

  #activationForThread(threadId: ThreadId): DaemonActivation {
    if (this.#activation !== undefined) return this.#activation;
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    this.#activationId = id;
    let activation: DaemonActivation | undefined;
    const controller = new AbortController();
    const work = this.#prepareForThread(
      threadId,
      this.#drainEpoch,
      controller.signal,
    ).catch(() => new Response(null, { status: 503 }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Response>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        if (activation !== undefined) this.#retainDaemonActivation(activation);
        resolve(new Response(null, { status: 503 }));
      }, DAEMON_ACTIVATION_DEADLINE_MS);
    });
    const response = Promise.race([work, deadline]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    activation = {
      id,
      threadId,
      startedAt,
      response,
      work,
      retained: Promise.resolve(),
      observations: new Map(),
      persistence: Promise.resolve(),
      retainedByContext: false,
    };
    if (this.env.DB !== undefined) {
      const observation = Schema.decodeUnknownSync(DaemonActivationObservation)(
        {
          submissionId: "",
          startedAt,
        },
      );
      activation.observations.set("", observation);
      activation.persistence = this.#recordDaemonActivation(
        activation,
        observation,
      ).catch(() => undefined);
    }
    activation.retained = response.then(
      () =>
        new Promise<void>((resolve) => {
          const grace = setTimeout(resolve, DAEMON_ACTIVATION_GRACE_MS);
          void work.then(
            () => {
              clearTimeout(grace);
              resolve();
            },
            () => {
              clearTimeout(grace);
              resolve();
            },
          );
        }),
    );
    this.#activation = activation;
    void work
      .then(() => this.#finishDaemonActivation(activation))
      .catch(() => undefined);
    void activation.retained
      .then(() => this.#finishDaemonActivation(activation))
      .catch(() => undefined);
    return activation;
  }

  async #activateWithRetry(threadId: ThreadId) {
    let response = await this.#activationForThread(threadId).response;
    if (response.ok) return response;
    await new Promise((resolve) =>
      setTimeout(resolve, TRANSIENT_ACTIVATION_RETRY_MS),
    );
    response = await this.#activationForThread(threadId).response;
    return response;
  }

  async #activateForFilesRead(threadId: ThreadId) {
    const activation = this.#activateWithRetry(threadId);
    let removeWaiter: () => void = () => undefined;
    const transport = new Promise<boolean>((resolve) => {
      const ready = () => {
        if (this.#authority?.threadId !== threadId || !this.#isTransportReady())
          return;
        this.#readinessWaiters.delete(ready);
        resolve(true);
      };
      removeWaiter = () => this.#readinessWaiters.delete(ready);
      this.#readinessWaiters.add(ready);
      // A repair exists only after a newly registered transport has started
      // activation. Other attached transports still need the live probe.
      if (this.#repair !== undefined) ready();
    });
    const available = await Promise.race([
      transport,
      activation.then(
        (response) => response.ok,
        () => false,
      ),
    ]);
    removeWaiter();
    return (
      available &&
      this.#authority?.threadId === threadId &&
      this.#isTransportReady()
    );
  }

  #retainDaemonActivation(activation: DaemonActivation) {
    if (activation.retainedByContext) return;
    activation.retainedByContext = true;
    this.ctx.waitUntil(activation.retained.catch(() => undefined));
  }

  async #finishDaemonActivation(activation: DaemonActivation) {
    if (this.#activation !== activation) return;
    this.#activation = undefined;
    this.#activationId = undefined;
    await activation.persistence;
    const stored = await this.#readDaemonActivationAttempt();
    if (stored?.activationId === activation.id)
      await Promise.all([
        this.ctx.storage.delete(ACTIVATION_ATTEMPT_STORAGE_KEY),
        this.ctx.storage.deleteAlarm(),
      ]);
  }

  async #readDaemonActivationAttempt(): Promise<
    DaemonActivationAttempt | undefined
  > {
    const raw = await this.ctx.storage.get(ACTIVATION_ATTEMPT_STORAGE_KEY);
    const attempt = Schema.decodeUnknownOption(DaemonActivationAttempt)(raw);
    if (Option.isSome(attempt)) return attempt.value;
    const legacy = Schema.decodeUnknownOption(LegacyDaemonActivationAttempt)(
      raw,
    );
    if (Option.isNone(legacy)) return undefined;
    return {
      activationId: legacy.value.activationId,
      threadId: legacy.value.threadId,
      deadlineAt: legacy.value.deadlineAt,
      submissions: [
        {
          submissionId: legacy.value.submissionId,
          startedAt: legacy.value.startedAt,
        },
      ],
    };
  }

  #persistDaemonActivation(activation: DaemonActivation) {
    activation.persistence = activation.persistence
      .catch(() => undefined)
      .then(async () => {
        if (this.#activation !== activation) return;
        const attempt = Schema.decodeUnknownSync(DaemonActivationAttempt)({
          activationId: activation.id,
          threadId: activation.threadId,
          deadlineAt: activation.startedAt + DAEMON_ACTIVATION_DEADLINE_MS,
          submissions: [...activation.observations.values()],
        });
        await this.ctx.storage.put(ACTIVATION_ATTEMPT_STORAGE_KEY, attempt);
        await this.ctx.storage.setAlarm(attempt.deadlineAt + 1_000);
      });
    return activation.persistence;
  }

  async #recordDaemonActivationFailure(
    attempt: {
      readonly activationId: string;
      readonly threadId: ThreadId;
    },
    observation: DaemonActivationTimingObservation,
  ) {
    if (this.env.DB === undefined) return;
    const correlation = Schema.decodeUnknownSync(StartupTraceCorrelation)({
      journey: "submission_daemon_activation",
      requestId: attempt.activationId,
      threadId: attempt.threadId,
      submissionId: observation.submissionId,
    });
    await recordStartupPhases(this.env.DB, [
      startupObservation(
        correlation,
        "workspace_ready",
        observation.startedAt,
        Date.now(),
        { outcome: "failed" },
      ),
    ]);
  }

  async #recordDaemonActivation(
    activation: DaemonActivation,
    observation: DaemonActivationTimingObservation,
  ) {
    if (this.env.DB === undefined) return;
    const correlation = Schema.decodeUnknownSync(StartupTraceCorrelation)({
      journey: "submission_daemon_activation",
      requestId: activation.id,
      threadId: activation.threadId,
      submissionId: observation.submissionId,
    });
    try {
      await this.#persistDaemonActivation(activation);
      await recordStartupPhases(this.env.DB, [
        startupObservation(
          correlation,
          "requested",
          observation.startedAt,
          observation.startedAt,
        ),
      ]);
      const response = await activation.response.catch(() => undefined);
      if (response === undefined || !response.ok) {
        await this.#recordDaemonActivationFailure(
          { activationId: activation.id, threadId: activation.threadId },
          observation,
        );
        return;
      }
      const decoded = Schema.decodeUnknownSync(DaemonReadiness)(
        await response.clone().json(),
      );
      const milestones = decoded.activationMilestones;
      if (
        milestones !== undefined &&
        milestones.releaseLoadedAt >= observation.startedAt
      ) {
        await recordStartupPhases(this.env.DB, [
          startupObservation(
            correlation,
            "release_loaded",
            observation.startedAt,
            milestones.releaseLoadedAt,
          ),
          startupObservation(
            correlation,
            "installed",
            observation.startedAt,
            milestones.installedAt,
          ),
          startupObservation(
            correlation,
            "connected",
            observation.startedAt,
            milestones.connectedAt,
          ),
          startupObservation(
            correlation,
            "environment_ready",
            observation.startedAt,
            milestones.environmentReadyAt,
          ),
        ]);
      }
      await recordStartupPhases(this.env.DB, [
        startupObservation(
          correlation,
          "workspace_ready",
          observation.startedAt,
        ),
      ]);
    } catch {
      await this.#recordDaemonActivationFailure(
        { activationId: activation.id, threadId: activation.threadId },
        observation,
      );
    }
  }

  async #prepareForThread(
    threadId: ThreadId,
    epoch: number,
    signal: AbortSignal,
  ): Promise<Response> {
    if (signal.aborted) return new Response(null, { status: 503 });
    if (epoch !== this.#drainEpoch) return new Response(null, { status: 503 });
    const existing = this.#authority;
    if (
      existing?.threadId === threadId &&
      existing.release === DXD_RELEASE &&
      existing.protocolMajor === DXD_PROTOCOL_MAJOR &&
      existing.terminalVersion === DXD_TERMINAL_VERSION &&
      existing.workloadIdentityVersion === DXD_WORKLOAD_IDENTITY_VERSION &&
      existing.attachmentNonce !== undefined &&
      !this.#isTransportReady()
    )
      await this.#expireCurrentDaemonConnection();
    if (this.#connectionRecovery !== undefined && !this.#isTransportReady()) {
      this.#connectionRecoveryWake?.("activated");
    }
    if (this.#connectionRecovery !== undefined) {
      await this.#connectionRecovery;
    }
    if (signal.aborted) return new Response(null, { status: 503 });
    if (epoch !== this.#drainEpoch) return new Response(null, { status: 503 });
    if (
      this.#isTransportReady() &&
      this.#repair === undefined &&
      this.#environmentActivation === undefined
    ) {
      const result = await this.#probeReadiness();
      if (result === "drained" || epoch !== this.#drainEpoch)
        return new Response(null, { status: 503 });
      if (result !== "ready" || !this.#isTransportReady())
        return this.#prepareForThread(threadId, epoch, signal);
    }
    if (
      this.#isTransportReady() &&
      this.#repair === undefined &&
      !this.#environmentReady
    ) {
      try {
        await (this.#environmentActivation ??
          this.#activateEnvironment(threadId));
      } catch {
        return new Response(null, { status: 503 });
      }
      if (signal.aborted) return new Response(null, { status: 503 });
      return this.#isReady()
        ? this.#readyResponse()
        : new Response(null, { status: 503 });
    }
    if (this.#isTransportReady() && this.#repair !== undefined) {
      try {
        await this.#repair;
      } catch {
        return new Response(null, { status: 503 });
      }
      if (signal.aborted) return new Response(null, { status: 503 });
      return this.#isReady()
        ? this.#readyResponse()
        : new Response(null, { status: 503 });
    }
    if (this.#isReady()) return this.#readyResponse();
    this.#residentRelay.workspaceWaking();
    return this.#runActivationBeforeDeadline(threadId, epoch, signal);
  }

  async #probeReadiness() {
    const socket = this.#currentDaemonSocket();
    const authority = this.#authority;
    if (socket === undefined || authority?.attachmentNonce === undefined)
      return "changed" as const;
    const nonce = authority.attachmentNonce;
    // dxd processes Files synchronously. Give work already ahead of the ping
    // its normal request budget rather than fencing a healthy, busy daemon.
    const timeoutMs =
      this.#pendingRequests.size === 0
        ? READINESS_PROBE_TIMEOUT_MS
        : DAEMON_REQUEST_TIMEOUT_MS;
    const result = await new Promise<
      "ready" | "changed" | "timeout" | "drained"
    >((resolve) => {
      const timeout = setTimeout(() => probe.settle("timeout"), timeoutMs);
      const probe = {
        socket,
        generation: authority.generation,
        nonce,
        requestId: randomBase64Url(18),
        deadline: Date.now() + timeoutMs,
        settle: (result: "ready" | "changed" | "timeout" | "drained") => {
          clearTimeout(timeout);
          if (this.#readinessProbe === probe) this.#readinessProbe = undefined;
          resolve(result);
        },
      };
      this.#readinessProbe = probe;
      try {
        socket.send(
          JSON.stringify({
            type: "readiness-ping",
            generation: probe.generation,
            requestId: probe.requestId,
          }),
        );
      } catch {
        probe.settle("timeout");
      }
    });
    // A heartbeat lease can outlive a paused guest. Prove a live round trip
    // before dispatch, without ever replaying a feature operation to wake it.
    if (
      result === "timeout" &&
      this.#authority?.generation === authority.generation &&
      this.#authority.attachmentNonce === nonce
    )
      await this.#loseDaemonConnection(socket, true);
    return result;
  }

  async #runActivationBeforeDeadline(
    threadId: ThreadId,
    epoch: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const endpoint =
      this.env.DX_DXD_PUBLIC_URL === undefined
        ? undefined
        : residentThreadDaemonEndpoint(this.env.DX_DXD_PUBLIC_URL, threadId);
    if (endpoint === undefined) return new Response(null, { status: 503 });
    let stage: "credential" | "install" | "registration" | "environment" =
      "credential";
    try {
      const previousKeyId = this.#authority?.apiKeyId;
      const runtime = Effect.runSync(loadRuntimeConfiguration(this.env));
      const credential = await mintThreadDaemonApiKey(this.env, threadId);
      if (signal.aborted || epoch !== this.#drainEpoch) {
        await revokeThreadDaemonApiKey(this.env, credential.id);
        throw new Error("activation deadline exceeded");
      }
      const authority: DaemonAuthority = {
        threadId,
        generation: Schema.decodeUnknownSync(DaemonGenerationSchema)(
          randomBase64Url(24),
        ),
        apiKeyId: credential.id,
        release: DXD_RELEASE,
        protocolMajor: DXD_PROTOCOL_MAJOR,
        terminalVersion: DXD_TERMINAL_VERSION,
        workloadIdentityVersion: DXD_WORKLOAD_IDENTITY_VERSION,
        runtimeProvider: runtime.executionAdapter,
        runtimeAssurance: "dx_dxd_channel_v1",
      };
      this.#authority = authority;
      await this.ctx.storage.put(AUTHORITY_STORAGE_KEY, authority);
      this.#failAllPending();
      this.#fenceDaemonSockets();
      await revokeThreadDaemonApiKey(this.env, previousKeyId);
      if (signal.aborted || epoch !== this.#drainEpoch) {
        await revokeThreadDaemonApiKey(this.env, credential.id);
        throw new Error("activation deadline exceeded");
      }
      stage = "install";
      const installation = await ExecutionWorkspaces.ensureDaemon({
        threadId,
        generation: authority.generation,
        apiKey: credential.key,
        endpoint,
        signal,
      });
      if (epoch !== this.#drainEpoch) {
        await revokeThreadDaemonApiKey(this.env, credential.id);
        throw new Error("activation cancelled by drain");
      }
      stage = "registration";
      if (!this.#isTransportReady()) {
        await new Promise<void>((resolve, reject) => {
          let timeout: ReturnType<typeof setTimeout>;
          let settled = false;
          const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.#readinessWaiters.delete(ready);
            callback();
          };
          const ready = () => settle(resolve);
          this.#readinessWaiters.add(ready);
          timeout = setTimeout(() => {
            settle(() => reject(new Error("timeout")));
          }, ACTIVATION_TIMEOUT_MS);
        });
      }
      if (epoch !== this.#drainEpoch)
        throw new Error("activation cancelled by drain");
      const connectedAt = Date.now();
      stage = "environment";
      await this.#repair;
      if (epoch !== this.#drainEpoch)
        throw new Error("activation cancelled by drain");
      if (!this.#isReady()) throw new Error("not ready");
      const activationMilestones =
        installation.releaseLoadedAt === undefined ||
        installation.installedAt === undefined
          ? undefined
          : {
              releaseLoadedAt: installation.releaseLoadedAt,
              installedAt: installation.installedAt,
              connectedAt,
              environmentReadyAt: Date.now(),
            };
      return this.#readyResponse(activationMilestones);
    } catch {
      threadDaemonLogger.error("Thread daemon activation failed.", {
        event: "thread_daemon_activation",
        threadId,
        stage,
      });
      return new Response(null, { status: 503 });
    }
  }

  #readyResponse(activationMilestones?: DaemonActivationMilestones) {
    return Response.json({
      ready: true,
      activationId: this.#activationId,
      release: DXD_RELEASE,
      protocolMajor: DXD_PROTOCOL_MAJOR,
      ...(activationMilestones === undefined ? {} : { activationMilestones }),
    });
  }

  #awaitTerminalHeartbeat(): Promise<DxdTerminalHeartbeat> {
    if (this.#terminalHeartbeat !== undefined)
      return Promise.resolve(this.#terminalHeartbeat);
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const ready = (state: DxdTerminalHeartbeat) => {
        clearTimeout(timeout);
        this.#terminalWaiters.delete(ready);
        resolve(state);
      };
      this.#terminalWaiters.add(ready);
      timeout = setTimeout(() => {
        this.#terminalWaiters.delete(ready);
        reject(new Error("terminal heartbeat timeout"));
      }, DXD_HEARTBEAT_LEASE_MS);
    });
  }

  #publishTerminalHeartbeat(state: DxdTerminalHeartbeat) {
    this.#terminalHeartbeat = state;
    for (const resolve of this.#terminalWaiters) resolve(state);
    this.#terminalWaiters.clear();
  }

  #sendTerminalControl(control: DxdCoreTerminalControl) {
    const socket = this.#currentDaemonSocket();
    if (socket === undefined) {
      void this.#expireCurrentDaemonConnection();
      throw new Error("daemon unavailable");
    }
    const encoded = JSON.stringify(control);
    if (
      new TextEncoder().encode(encoded).byteLength > DXD_MAX_CONTROL_FRAME_BYTES
    )
      throw new Error("terminal control too large");
    try {
      socket.send(encoded);
    } catch {
      this.#loseDaemonConnection(socket, true);
      throw new Error("daemon unavailable");
    }
  }

  #sendTerminalBinary(frame: Uint8Array) {
    const socket = this.#currentDaemonSocket();
    if (socket === undefined) {
      void this.#expireCurrentDaemonConnection();
      throw new Error("daemon unavailable");
    }
    if (
      frame.byteLength < 1 ||
      frame.byteLength > DXD_TERMINAL_MAX_FRAME_BYTES ||
      !this.#canSendTerminalBinary(frame.byteLength)
    )
      throw new Error("daemon unavailable");
    try {
      socket.send(frame);
    } catch {
      void this.#loseDaemonConnection(socket, true);
      throw new Error("daemon unavailable");
    }
  }

  #canSendTerminalBinary(frameBytes: number) {
    const socket = this.#currentDaemonSocket();
    const bufferedAmount = socket?.bufferedAmount;
    const permitted =
      socket !== undefined &&
      frameBytes >= 1 &&
      frameBytes <= DXD_TERMINAL_MAX_FRAME_BYTES &&
      (typeof bufferedAmount !== "number" ||
        bufferedAmount + frameBytes <= DXD_TERMINAL_SEND_BUFFER_BYTES);
    if (!permitted && socket !== undefined)
      threadDaemonLogger.warn("Thread daemon input is backpressured.", {
        event: "thread_daemon_input_backpressure",
        bufferedAmount,
        frameBytes,
      });
    return permitted;
  }

  #residentTransport(
    threadId: ThreadId,
    record: (phase: ThreadTerminalServerPhase) => void,
    socket: WebSocket,
  ): ResidentTerminalTransport {
    return {
      activate: async () => {
        const response = await this.#activateWithRetry(threadId);
        if (!response.ok) throw new Error("resident daemon unavailable");
        return this.#awaitTerminalHeartbeat();
      },
      refreshEnvironment: async () => {
        await this.#activateEnvironment(threadId);
        return this.#awaitTerminalHeartbeat();
      },
      sendControl: (control) => this.#sendTerminalControl(control),
      sendBinary: (frame) => this.#sendTerminalBinary(frame),
      canSendBinary: (frameBytes) => this.#canSendTerminalBinary(frameBytes),
      beforeInput: () => this.#beforeResidentInput(threadId),
      persist: (terminal) => {
        const authority = this.#authority;
        const daemonIdentity =
          authority !== undefined && authority.threadId === threadId
            ? {
                daemonGeneration: authority.generation,
                nonce: authority.attachmentNonce,
              }
            : {};
        socket.serializeAttachment({
          kind: "resident-browser",
          threadId,
          ...daemonIdentity,
          terminal,
        } satisfies ResidentBrowserAttachment);
      },
      record,
    };
  }

  #closeResidentBrowserForReconnect(socket: WebSocket) {
    try {
      socket.send(
        JSON.stringify({
          v: 1,
          type: "error",
          code: "reconnect-required",
          retry: "immediate-once",
        }),
      );
      socket.close(1012, "");
    } catch {
      // A hibernated peer may already have disconnected.
    }
  }

  async #beforeResidentInput(threadId: ThreadId) {
    if (this.#currentDaemonSocket() === undefined) {
      void this.#expireCurrentDaemonConnection();
      throw new Error("resident daemon unavailable");
    }
    if (!this.#environmentReady) await this.#activateEnvironment(threadId);
    await ExecutionWorkspaces.recordResidentTerminalInput(threadId);
    if (this.#residentChanges === undefined && this.env.DB !== undefined)
      this.#residentChanges = makeResidentThreadChangesTerminalObserver({
        db: this.env.DB,
        threadId,
        residentRefresh: async (refresh) => {
          const socket = this.#currentDaemonSocket();
          if (socket === undefined || !this.#isReady()) return false;
          const encoded = JSON.stringify(refresh);
          if (
            new TextEncoder().encode(encoded).byteLength >
            DXD_MAX_CONTROL_FRAME_BYTES
          )
            return false;
          socket.send(encoded);
          return true;
        },
      });
    await this.#residentChanges?.beforeInput();
  }

  async #requestDaemon(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      request.headers.get("x-dx-daemon-request") !== "1"
    )
      return new Response(null, { status: 404 });
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      request.headers.get("x-dx-thread-id"),
    );
    if (Option.isNone(threadId)) return new Response(null, { status: 503 });
    if (this.#pendingRequests.size >= MAX_PENDING_DAEMON_REQUESTS)
      return daemonFailureResponse("known");
    let operation: typeof DxdFilesOperation.Type;
    try {
      const body = await request.text();
      if (
        new TextEncoder().encode(body).byteLength > DXD_MAX_REQUEST_FRAME_BYTES
      )
        return new Response(null, { status: 400 });
      operation = Schema.decodeUnknownSync(DxdFilesOperation)(
        JSON.parse(body),
        {
          onExcessProperty: "error",
        },
      );
    } catch {
      return new Response(null, { status: 400 });
    }
    const readOnly =
      operation.operation === "files.list" ||
      operation.operation === "files.read";
    const available = readOnly
      ? await this.#activateForFilesRead(threadId.value)
      : (await this.#activateWithRetry(threadId.value)).ok;
    if (!available) return daemonFailureResponse("known");
    const authority = this.#authority;
    if (
      authority === undefined ||
      threadId.value !== authority.threadId ||
      this.#pendingRequests.size >= MAX_PENDING_DAEMON_REQUESTS
    )
      return daemonFailureResponse("known");
    return this.#dispatchDaemonOperation(
      authority,
      operation,
      DXD_MAX_REQUEST_FRAME_BYTES,
      DAEMON_REQUEST_TIMEOUT_MS,
    );
  }

  #dispatchDaemonOperation(
    authority: DaemonAuthority,
    operation: DxdOperation,
    maximumBytes: number,
    timeoutMs: number,
  ): Promise<Response> {
    if (
      !this.#sameDaemonAuthority(authority) ||
      this.#pendingRequests.size >= MAX_PENDING_DAEMON_REQUESTS
    )
      return Promise.resolve(daemonFailureResponse("known"));
    const requestId = randomBase64Url(18);
    const frame = JSON.stringify({
      type: "request",
      generation: authority.generation,
      requestId,
      operation,
    });
    if (new TextEncoder().encode(frame).byteLength > maximumBytes)
      return Promise.resolve(new Response(null, { status: 400 }));
    return new Promise<Response>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const timeout = setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId);
        this.#settlePending(
          requestId,
          daemonFailureResponse(
            pending?.dispatched === true ? "unknown" : "known",
          ),
        );
      }, timeoutMs);
      this.#pendingRequests.set(requestId, {
        authority: {
          threadId: authority.threadId,
          generation: authority.generation,
        },
        operation,
        maximumBytes,
        resumable:
          operation.operation === "environment.activate" ||
          operation.operation === "files.list" ||
          operation.operation === "files.read",
        deadline,
        timeout,
        resolve,
        dispatched: false,
      });
      this.#resumePendingRequests();
    });
  }

  #sameDaemonAuthority(
    authority: Pick<DaemonAuthority, "threadId" | "generation">,
  ) {
    return (
      this.#authority?.threadId === authority.threadId &&
      this.#authority.generation === authority.generation
    );
  }

  #resumePendingRequests() {
    const socket = this.#currentDaemonSocket();
    if (socket === undefined) return;
    for (const [requestId, pending] of this.#pendingRequests) {
      if (
        pending.socket !== undefined ||
        !this.#sameDaemonAuthority(pending.authority) ||
        Date.now() >= pending.deadline ||
        (pending.operation.operation !== "environment.activate" &&
          pending.operation.operation !== "files.list" &&
          pending.operation.operation !== "files.read" &&
          !this.#isReady())
      )
        continue;
      const frame = JSON.stringify({
        type: "request",
        generation: pending.authority.generation,
        requestId,
        operation: pending.operation,
      });
      if (new TextEncoder().encode(frame).byteLength > pending.maximumBytes) {
        this.#settlePending(requestId, new Response(null, { status: 400 }));
        continue;
      }
      pending.socket = socket;
      pending.dispatched = true;
      try {
        socket.send(frame);
      } catch {
        void this.#loseDaemonConnection(socket, true);
        return;
      }
    }
  }

  async #activateEnvironment(threadId: ThreadId) {
    this.#environmentReady = false;
    this.#environmentDirty = true;
    if (this.#environmentActivation !== undefined)
      return this.#environmentActivation;
    let activation: Promise<void>;
    activation = this.#runEnvironmentActivation(threadId).finally(() => {
      if (this.#environmentActivation === activation)
        this.#environmentActivation = undefined;
    });
    this.#environmentActivation = activation;
    return activation;
  }

  async #runEnvironmentActivation(threadId: ThreadId) {
    this.#environmentReady = false;
    this.#appliedEnvironment = undefined;
    await this.ctx.storage.delete(APPLIED_ENVIRONMENT_STORAGE_KEY);
    while (true) {
      this.#environmentDirty = false;
      const applied = await this.#activateEnvironmentOnce(threadId);
      if (this.#environmentDirty) continue;
      const authority = this.#authority;
      if (
        authority?.attachmentNonce === undefined ||
        authority.threadId !== threadId ||
        this.#currentDaemonSocket() === undefined
      )
        throw new Error("environment unavailable");
      const marker: AppliedEnvironmentMarker = {
        version: 1,
        daemonGeneration: authority.generation,
        connectionNonce: authority.attachmentNonce,
        appliedGeneration: applied.generation,
        revisions: applied.revision,
      };
      await this.ctx.storage.put(APPLIED_ENVIRONMENT_STORAGE_KEY, marker);
      if (
        this.#environmentDirty ||
        this.#authority !== authority ||
        this.#currentDaemonSocket() === undefined
      ) {
        await this.ctx.storage.delete(APPLIED_ENVIRONMENT_STORAGE_KEY);
        continue;
      }
      this.#appliedEnvironment = marker;
      this.#environmentReady = true;
      this.#resumePendingRequests();
      return;
    }
  }

  async #activateEnvironmentOnce(threadId: ThreadId) {
    const authority = this.#authority;
    if (
      authority === undefined ||
      authority.threadId !== threadId ||
      !this.#isTransportReady()
    )
      throw new Error("environment unavailable");
    const generation = this.#nextEnvironmentGeneration;
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error("environment unavailable");
    const nextGeneration = generation + 1;
    if (!Number.isSafeInteger(nextGeneration))
      throw new Error("environment unavailable");
    this.#nextEnvironmentGeneration = nextGeneration;
    await this.ctx.storage.put(
      ENVIRONMENT_GENERATION_STORAGE_KEY,
      nextGeneration,
    );
    const snapshot = await Effect.runPromise(
      resolveExecutionEnvironment(this.env, threadId),
    );
    const signing = await Effect.runPromise(
      resolveExecutionSigningPlan(this.env, threadId),
    );
    const db = await Effect.runPromise(decodeD1Binding(this.env.DB));
    const source = await db
      .prepare(
        "SELECT provider, repository_full_name FROM thread_source_snapshot WHERE thread_id = ? LIMIT 1",
      )
      .bind(threadId)
      .first<{ provider: string; repository_full_name: string }>();
    let bitbucketGateway:
      | { readonly origin: string; readonly repository: string }
      | undefined;
    if (source?.provider === "bitbucket") {
      const origin = new URL(this.env.DX_AUTH_URL as string).origin;
      if (origin.startsWith("https://"))
        bitbucketGateway = { origin, repository: source.repository_full_name };
    }
    const legacyDefaultAuthor =
      signing.author.name === "dx" &&
      signing.author.email === "noreply@dx.local";
    const origin = new URL(this.env.DX_AUTH_URL as string).origin;
    const operation = environmentActivationOperation(snapshot, generation, {
      authorName: legacyDefaultAuthor ? "dxcodeagent" : signing.author.name,
      authorEmail: legacyDefaultAuthor
        ? "agent@dxcode.dev"
        : signing.author.email,
      threadUrl: `${origin}/threads/${threadId}`,
      // Preferred policy falls back to unsigned Git when no managed key is
      // available. Required signing stays fail-closed through Git's signer.
      signingEnabled: signing.policy === "required" || "credential" in signing,
      ...(bitbucketGateway === undefined ? {} : { bitbucketGateway }),
    });
    const response = await this.#dispatchDaemonOperation(
      authority,
      operation,
      DXD_MAX_ENVIRONMENT_REQUEST_FRAME_BYTES,
      ACTIVATION_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error("environment unavailable");
    const result = Schema.decodeUnknownSync(DxdEnvironmentActivateResult)(
      await response.json(),
      { onExcessProperty: "error" },
    );
    if (
      result.generation !== generation ||
      result.kind === "unavailable" ||
      result.kind === "superseded"
    )
      throw new Error("environment unavailable");
    if (result.shell === "restart-required") {
      const heartbeat = this.#terminalHeartbeat;
      if (heartbeat !== undefined && heartbeat.state !== "absent")
        this.#terminalHeartbeat = { ...heartbeat, restartRequired: true };
      const socket = this.#currentDaemonSocket();
      const currentAuthority = this.#authority;
      if (
        socket !== undefined &&
        currentAuthority !== undefined &&
        this.#sameDaemonAuthority(authority)
      )
        socket.serializeAttachment({
          kind: "daemon",
          generation: currentAuthority.generation,
          nonce: currentAuthority.attachmentNonce,
          terminal: this.#terminalHeartbeat,
        } satisfies DaemonAttachment);
      this.#residentRelay.environmentRestartRequired();
    }
    return { generation, revision: snapshot.revision };
  }

  async #refreshEnvironment(request: Request) {
    if (
      request.method !== "POST" ||
      request.headers.get("x-dx-environment-refresh") !== "1"
    )
      return new Response(null, { status: 404 });
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      request.headers.get("x-dx-thread-id"),
    );
    if (Option.isNone(threadId)) return new Response(null, { status: 404 });
    const authority = this.#authority;
    if (authority === undefined || authority.threadId !== threadId.value)
      return new Response(null, { status: 404 });
    if (!this.#isTransportReady()) {
      this.#environmentReady = false;
      this.#appliedEnvironment = undefined;
      await this.ctx.storage.delete(APPLIED_ENVIRONMENT_STORAGE_KEY);
      return new Response(null, { status: 204 });
    }
    try {
      await this.#activateEnvironment(threadId.value);
      return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 503 });
    }
  }

  async #drainDaemon(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      request.headers.get("x-dx-daemon-drain") !== "1"
    )
      return new Response(null, { status: 404 });
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      request.headers.get("x-dx-thread-id"),
    );
    const reason = request.headers.get("x-dx-daemon-drain-reason");
    if (
      Option.isNone(threadId) ||
      ![
        "thread-archived",
        "workspace-paused",
        "thread-deleted",
        "workspace-lost",
      ].includes(reason ?? "")
    )
      return new Response(null, { status: 404 });
    const authority = this.#authority;
    if (authority !== undefined && authority.threadId !== threadId.value)
      return new Response(null, { status: 404 });
    this.#drainEpoch += 1;
    this.#readinessProbe?.settle("drained");
    await this.#residentChanges?.beforeSuspend();
    const retry =
      reason === "thread-archived"
        ? "after-unarchive"
        : reason === "workspace-paused"
          ? "on-focus"
          : "never";
    this.#residentRelay.closeForLifecycle(
      reason as
        | "thread-archived"
        | "workspace-paused"
        | "thread-deleted"
        | "workspace-lost",
      retry,
      1000,
    );
    this.#authority = undefined;
    this.#failAllPending();
    this.#fenceDaemonSockets();
    for (const resolve of this.#readinessWaiters) resolve();
    this.#readinessWaiters.clear();
    this.#terminalHeartbeat = undefined;
    this.#environmentReady = false;
    this.#appliedEnvironment = undefined;
    ExecutionWorkspaces.recordResidentTerminalHeartbeat(
      threadId.value,
      undefined,
    );
    await Promise.all([
      this.ctx.storage.delete(AUTHORITY_STORAGE_KEY),
      this.ctx.storage.delete(APPLIED_ENVIRONMENT_STORAGE_KEY),
    ]);
    await revokeThreadDaemonApiKey(this.env, authority?.apiKeyId);
    return new Response(null, { status: 204 });
  }

  #isTransportReady(now = Date.now()) {
    const authority = this.#authority;
    return (
      authority?.attachmentNonce !== undefined &&
      authority.lastSeen !== undefined &&
      authority.release === DXD_RELEASE &&
      authority.protocolMajor === DXD_PROTOCOL_MAJOR &&
      authority.terminalVersion === DXD_TERMINAL_VERSION &&
      authority.workloadIdentityVersion === DXD_WORKLOAD_IDENTITY_VERSION &&
      now - authority.lastSeen <= DXD_HEARTBEAT_LEASE_MS &&
      this.ctx.getWebSockets().some((socket) => {
        const attachment = socket.deserializeAttachment() as
          | DaemonAttachment
          | undefined;
        return (
          attachment?.kind === "daemon" &&
          attachment.generation === authority.generation &&
          attachment.nonce === authority.attachmentNonce
        );
      })
    );
  }

  #isReady(now = Date.now()) {
    return (
      this.#environmentReady &&
      this.#repair === undefined &&
      this.#isTransportReady(now)
    );
  }

  #currentDaemonSocket() {
    const authority = this.#authority;
    if (
      authority?.attachmentNonce === undefined ||
      authority.lastSeen === undefined ||
      Date.now() - authority.lastSeen > DXD_HEARTBEAT_LEASE_MS
    )
      return undefined;
    return this.ctx.getWebSockets().find((socket) => {
      const attachment = socket.deserializeAttachment() as
        | DaemonAttachment
        | undefined;
      return (
        attachment?.kind === "daemon" &&
        attachment.generation === authority.generation &&
        attachment.nonce === authority.attachmentNonce
      );
    });
  }

  #isCurrentWorkloadIdentityAuthority(
    expected: DaemonAuthority,
    socket: WebSocket,
  ) {
    const current = this.#authority;
    return (
      current !== undefined &&
      current.threadId === expected.threadId &&
      current.generation === expected.generation &&
      current.apiKeyId === expected.apiKeyId &&
      current.release === expected.release &&
      current.protocolMajor === expected.protocolMajor &&
      current.terminalVersion === expected.terminalVersion &&
      current.workloadIdentityVersion === expected.workloadIdentityVersion &&
      current.runtimeProvider === expected.runtimeProvider &&
      current.runtimeAssurance === expected.runtimeAssurance &&
      current.attachmentNonce === expected.attachmentNonce &&
      this.#currentDaemonSocket() === socket
    );
  }

  async #issueNativeGitCredential(
    threadId: string,
    request: Extract<
      DxdWorkloadIdentityRequest["request"],
      { kind: "git-credential" }
    >,
  ) {
    const db = await Effect.runPromise(decodeD1Binding(this.env.DB));
    const source = await db
      .prepare(
        `SELECT t.owner_user_id, s.provider, s.repository_full_name
         FROM threads t JOIN thread_source_snapshot s ON s.thread_id = t.id
         WHERE t.id = ? LIMIT 1`,
      )
      .bind(threadId)
      .first<{
        owner_user_id: string;
        provider: "github" | "bitbucket";
        repository_full_name: string;
      }>();
    const normalized = request.path
      .replace(/^\/+/, "")
      .replace(/\/info\/lfs(?:\/.*)?$/, "")
      .replace(/\.git$/, "")
      .toLowerCase();
    if (source === null) return undefined;
    const expectedBitbucketPath =
      `api/source/bitbucket/git/${source.repository_full_name}`.toLowerCase();
    const bitbucketOrigin = new URL(this.env.DX_AUTH_URL as string);
    const valid =
      (source.provider === "github" &&
        request.host.toLowerCase() === "github.com" &&
        normalized === source.repository_full_name.toLowerCase()) ||
      (source.provider === "bitbucket" &&
        request.host.toLowerCase() === bitbucketOrigin.host.toLowerCase() &&
        normalized === expectedBitbucketPath);
    if (!valid) return undefined;
    return Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* SourceRuntimeBroker;
        const environment = yield* broker.withCommandEnvironment(
          threadId,
          source.owner_user_id,
          {
            // Git credential `get` cannot reveal whether this request will
            // fetch, push, or update a workflow. Mint one repository-scoped
            // token with the complete truthful native-Git write envelope.
            operation:
              source.provider === "bitbucket"
                ? "contents-push"
                : "workflow-write",
            invocationSource: "git-helper",
          },
          (value) => Effect.succeed(value),
        );
        if (source.provider === "github") {
          const password = environment.GH_TOKEN;
          return password === undefined
            ? undefined
            : { username: "x-access-token", password };
        }
        const password = environment.DX_BITBUCKET_GIT_TOKEN;
        return password === undefined
          ? undefined
          : { username: "dx", password };
      }).pipe(Effect.provide(sourceWorkspaceLayer(this.env, db).runtime)),
    );
  }

  async #issueWorkloadIdentity(
    socket: WebSocket,
    authority: DaemonAuthority,
    message: DxdWorkloadIdentityRequest,
  ) {
    if (
      message.generation !== authority.generation ||
      this.#pendingWorkloadIdentityRequests.has(message.requestId)
    )
      return;
    const current = () =>
      this.#isCurrentWorkloadIdentityAuthority(authority, socket);
    let result:
      | {
          readonly kind: "issued";
          readonly token: string;
          readonly expiresAt: number;
        }
      | { readonly kind: "signed"; readonly signature: string }
      | {
          readonly kind: "credential";
          readonly username: string;
          readonly password: string;
        }
      | { readonly kind: "unauthorized" | "unavailable" };
    if (
      this.#pendingWorkloadIdentityRequests.size >=
      MAX_PENDING_WORKLOAD_IDENTITY_REQUESTS
    ) {
      result = { kind: "unavailable" };
    } else {
      this.#pendingWorkloadIdentityRequests.add(message.requestId);
      try {
        if ("kind" in message.request && message.request.kind === "git-sign") {
          const payload = Uint8Array.from(
            atob(
              message.request.payloadBase64
                .replaceAll("-", "+")
                .replaceAll("_", "/"),
            ),
            (character) => character.charCodeAt(0),
          );
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            payload,
          );
          const plan = await Effect.runPromise(
            resolveExecutionSigningPlan(this.env, authority.threadId),
          );
          const credential = "credential" in plan ? plan.credential : undefined;
          const identities = nativeGitCommitIdentities(text);
          if (
            plan.policy === "disabled" ||
            credential === undefined ||
            identities?.committer[1] !== plan.author.name ||
            identities.committer[2] !== plan.author.email ||
            identities.author[1] !== plan.author.name ||
            identities.author[2] !== plan.author.email
          ) {
            result = { kind: "unavailable" };
          } else {
            result = {
              kind: "signed",
              signature: await signGitPayload(
                credential.privateKey,
                credential.publicKey,
                payload,
              ),
            };
          }
        } else if (
          "kind" in message.request &&
          message.request.kind === "git-credential"
        ) {
          const credential = await this.#issueNativeGitCredential(
            authority.threadId,
            message.request,
          );
          result =
            credential === undefined
              ? { kind: "unavailable" }
              : { kind: "credential", ...credential };
        } else {
          const issued = await workloadIdentityBroker.issue(
            this.env,
            {
              threadId: Schema.decodeUnknownSync(ThreadId)(authority.threadId),
              runtimeProvider: authority.runtimeProvider,
              runtimeAssurance: authority.runtimeAssurance,
              isCurrent: current,
            },
            message.request,
          );
          result = { kind: "issued", ...issued };
        }
      } catch (cause) {
        result = {
          kind:
            cause instanceof WorkloadIdentityUnauthorized
              ? "unauthorized"
              : "unavailable",
        };
      } finally {
        this.#pendingWorkloadIdentityRequests.delete(message.requestId);
      }
    }
    if (!current()) return;
    let encoded = JSON.stringify({
      type: "workload-identity.response",
      generation: authority.generation,
      requestId: message.requestId,
      result,
    });
    if (
      new TextEncoder().encode(encoded).byteLength >
      DXD_MAX_WORKLOAD_IDENTITY_FRAME_BYTES
    ) {
      encoded = JSON.stringify({
        type: "workload-identity.response",
        generation: authority.generation,
        requestId: message.requestId,
        result: { kind: "unavailable" },
      });
    }
    if (!current()) return;
    try {
      socket.send(encoded);
    } catch {
      await this.#loseDaemonConnection(socket, true);
    }
  }

  #acceptDaemon(request: Request) {
    const authority = this.#authority;
    if (
      request.headers.get("x-dx-daemon-ingress") !== "1" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      authority === undefined ||
      request.headers.get("x-dx-daemon-key-id") !== authority.apiKeyId
    )
      return new Response(null, { status: 404 });
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      request.headers.get("x-dx-thread-id"),
    );
    if (Option.isNone(threadId) || threadId.value !== authority.threadId)
      return new Response(null, { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ kind: "daemon" } satisfies DaemonAttachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async #queueChangesRefresh(request: Request) {
    if (
      request.method !== "POST" ||
      request.headers.get("x-dx-changes-refresh") !== "1" ||
      request.headers.get("x-dx-thread-id") !== this.#authority?.threadId ||
      !this.#isReady()
    )
      return new Response(null, { status: 503 });
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > DXD_MAX_CONTROL_FRAME_BYTES)
      return new Response(null, { status: 400 });
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return new Response(null, { status: 400 });
    }
    const refresh = Schema.decodeUnknownOption(DxdChangesRefreshMessage)(
      decoded,
      { onExcessProperty: "error" },
    );
    if (Option.isNone(refresh)) return new Response(null, { status: 400 });
    const socket = this.#currentDaemonSocket();
    if (socket === undefined) return new Response(null, { status: 503 });
    socket.send(JSON.stringify(refresh.value));
    return new Response(null, { status: 202 });
  }

  async webSocketMessage(socket: WebSocket, frame: string | ArrayBuffer) {
    const frameBytes =
      typeof frame === "string"
        ? new TextEncoder().encode(frame).byteLength
        : frame.byteLength;
    const authority = this.#authority;
    const attachment = socket.deserializeAttachment() as
      | SocketAttachment
      | undefined;
    if (attachment?.kind === "changes-browser") {
      // This channel grants observation only, never terminal or daemon commands.
      socket.close(1008, "Read-only channel");
      return;
    }
    if (attachment?.kind === "resident-browser") {
      await this.#residentRelay.receiveBrowser(socket, frame);
      return;
    }
    const currentIdentity =
      authority !== undefined &&
      attachment?.kind === "daemon" &&
      attachment?.generation === authority.generation &&
      attachment.nonce === authority.attachmentNonce;
    const current =
      currentIdentity &&
      authority.lastSeen !== undefined &&
      Date.now() - authority.lastSeen <= DXD_HEARTBEAT_LEASE_MS;
    if (typeof frame !== "string") {
      if (currentIdentity && !current) {
        await this.#loseDaemonConnection(socket, true);
        return;
      }
      if (!current) return;
      if (frameBytes > DXD_TERMINAL_MAX_FRAME_BYTES) {
        socket.close(1009, "");
        return;
      }
      try {
        this.#residentRelay.receiveBinary(frame);
      } catch {
        socket.close(1008, "");
      }
      return;
    }
    if (frameBytes > DXD_MAX_CLIENT_FRAME_BYTES) {
      socket.close(1008, "Invalid daemon message.");
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame);
    } catch {
      socket.close(1008, "Invalid daemon message.");
      return;
    }
    const messageType =
      typeof decoded === "object" && decoded !== null && "type" in decoded
        ? decoded.type
        : undefined;
    if (
      ((messageType === "register" ||
        messageType === "heartbeat" ||
        messageType === "readiness-pong") &&
        frameBytes > DXD_MAX_CONTROL_FRAME_BYTES) ||
      (typeof messageType === "string" &&
        messageType.startsWith("terminal.") &&
        frameBytes > DXD_MAX_CONTROL_FRAME_BYTES) ||
      (messageType === "changes-candidate" &&
        frameBytes > DXD_MAX_CHANGES_CANDIDATE_BYTES) ||
      (messageType === "workload-identity.request" &&
        frameBytes > DXD_MAX_CONTROL_FRAME_BYTES) ||
      (messageType === "response" && frameBytes > DXD_MAX_RESPONSE_FRAME_BYTES)
    ) {
      socket.close(1008, "Invalid daemon message.");
      return;
    }
    const control = Schema.decodeUnknownOption(DxdClientControlMessage)(
      decoded,
      {
        onExcessProperty: "error",
      },
    );
    const response = Schema.decodeUnknownOption(DxdResponseEnvelope)(decoded, {
      onExcessProperty: "error",
    });
    const candidate = Schema.decodeUnknownOption(DxdChangesCandidateMessage)(
      decoded,
      { onExcessProperty: "error" },
    );
    const workloadIdentityRequest = Schema.decodeUnknownOption(
      DxdWorkloadIdentityRequestMessage,
    )(decoded, { onExcessProperty: "error" });
    if (
      Option.isNone(control) &&
      Option.isNone(response) &&
      Option.isNone(candidate) &&
      Option.isNone(workloadIdentityRequest)
    ) {
      socket.close(1008, "Invalid daemon message.");
      return;
    }
    if (Option.isSome(control) && control.value.type === "register") {
      if (
        authority === undefined ||
        control.value.generation !== authority.generation ||
        control.value.release !== authority.release ||
        control.value.protocolMajor !== authority.protocolMajor ||
        control.value.capabilities.terminal.version !==
          authority.terminalVersion ||
        control.value.capabilities.workloadIdentity.version !==
          authority.workloadIdentityVersion
      ) {
        socket.close(1008, "Daemon registration rejected.");
        return;
      }
      const nonce = randomBase64Url(18);
      const next = {
        ...authority,
        attachmentNonce: nonce,
        lastSeen: Date.now(),
      };
      this.#authority = next;
      this.#lastPersistedHeartbeatAt = next.lastSeen;
      this.#terminalHeartbeat = undefined;
      this.#environmentReady = false;
      this.#appliedEnvironment = undefined;
      this.#terminalResetRequired = true;
      this.#residentRelay.daemonConnectionReset();
      this.#fenceDaemonSockets(socket);
      await Promise.all([
        this.ctx.storage.put(AUTHORITY_STORAGE_KEY, next),
        this.ctx.storage.delete(APPLIED_ENVIRONMENT_STORAGE_KEY),
      ]);
      socket.serializeAttachment({
        kind: "daemon",
        generation: next.generation,
        nonce,
      } satisfies DaemonAttachment);
      socket.send(
        JSON.stringify({
          type: "registered",
          generation: next.generation,
          heartbeatIntervalMs: DXD_HEARTBEAT_INTERVAL_MS,
          heartbeatLeaseMs: DXD_HEARTBEAT_LEASE_MS,
        }),
      );
      this.#resumePendingRequests();
      this.#startRepair(Schema.decodeUnknownSync(ThreadId)(authority.threadId));
      this.#readinessProbe?.settle("changed");
      this.#connectionRecoveryWake?.("registered");
      for (const resolve of this.#readinessWaiters) resolve();
      return;
    }
    if (currentIdentity && !current) {
      await this.#loseDaemonConnection(socket, true);
      return;
    }
    if (!current || authority === undefined) return;
    if (Option.isSome(control) && control.value.type === "changes-dirty") {
      this.#observeChanges(
        socket,
        Schema.decodeUnknownSync(ThreadId)(authority.threadId),
      );
      return;
    }
    if (Option.isSome(control) && control.value.type === "readiness-pong") {
      const probe = this.#readinessProbe;
      if (
        probe !== undefined &&
        probe.socket === socket &&
        probe.generation === authority.generation &&
        probe.nonce === authority.attachmentNonce &&
        control.value.generation === probe.generation &&
        control.value.requestId === probe.requestId &&
        Date.now() < probe.deadline
      ) {
        this.#authority = { ...authority, lastSeen: Date.now() };
        probe.settle("ready");
      }
      return;
    }
    if (Option.isSome(workloadIdentityRequest)) {
      await this.#issueWorkloadIdentity(
        socket,
        authority,
        workloadIdentityRequest.value,
      );
      return;
    }
    if (Option.isSome(response)) {
      const pending = this.#pendingRequests.get(response.value.requestId);
      if (
        pending?.socket !== socket ||
        response.value.generation !== authority.generation
      )
        return;
      this.#settlePending(
        response.value.requestId,
        Response.json(response.value.result),
      );
      return;
    }
    if (Option.isSome(candidate)) {
      if (this.env.DB === undefined || this.env.DX_STORAGE === undefined) {
        threadDaemonLogger.warn(
          "Thread Changes candidate bindings are unavailable.",
          {
            event: "thread_changes_candidate_bindings_unavailable",
            threadId: authority.threadId,
          },
        );
      } else {
        this.ctx.waitUntil(
          this.#publishChanges(
            socket,
            Schema.decodeUnknownSync(ThreadId)(authority.threadId),
            candidate.value,
          ).catch((cause) => {
            threadDaemonLogger.warn(
              "Thread Changes candidate publication failed.",
              {
                event: "thread_changes_candidate_publication_failed",
                threadId: authority.threadId,
                cause,
              },
            );
          }),
        );
      }
      return;
    }
    if (Option.isNone(control)) return;
    if (isTerminalControl(control.value)) {
      if (control.value.type === "terminal.resident-state") {
        if (
          control.value.state === "exited" ||
          control.value.state === "failed"
        )
          await this.#residentChanges?.beforeSuspend();
        this.#publishTerminalHeartbeat({
          terminalVersion: DXD_TERMINAL_VERSION,
          terminal: "default",
          state: control.value.state,
          residentGeneration: control.value.residentGeneration,
          foregroundCommand: control.value.foregroundCommand,
          restartRequired: control.value.restartRequired,
        });
        ExecutionWorkspaces.recordResidentTerminalHeartbeat(
          Schema.decodeUnknownSync(ThreadId)(authority.threadId),
          control.value.foregroundCommand,
        );
        socket.serializeAttachment({
          kind: "daemon",
          generation: authority.generation,
          nonce: authority.attachmentNonce,
          terminal: this.#terminalHeartbeat,
        } satisfies DaemonAttachment);
      }
      this.#residentRelay.receiveControl(control.value);
      return;
    }
    if (
      control.value.type !== "heartbeat" ||
      control.value.generation !== authority.generation
    )
      return;
    if (this.#terminalResetRequired) {
      if (control.value.terminal.state !== "absent")
        this.#sendTerminalControl({
          terminalVersion: DXD_TERMINAL_VERSION,
          type: "terminal.reset-attachments",
          terminal: "default",
          residentGeneration: control.value.terminal.residentGeneration,
        });
      this.#terminalResetRequired = false;
      this.#residentRelay.attachmentsReset();
    }
    this.#publishTerminalHeartbeat(control.value.terminal);
    this.#residentRelay.daemonHeartbeat();
    ExecutionWorkspaces.recordResidentTerminalHeartbeat(
      Schema.decodeUnknownSync(ThreadId)(authority.threadId),
      control.value.terminal.state === "absent"
        ? false
        : control.value.terminal.foregroundCommand,
    );
    const now = Date.now();
    const next = { ...authority, lastSeen: now };
    this.#authority = next;
    socket.serializeAttachment({
      kind: "daemon",
      generation: authority.generation,
      nonce: authority.attachmentNonce,
      terminal: control.value.terminal,
    } satisfies DaemonAttachment);
    if (
      this.#lastPersistedHeartbeatAt === undefined ||
      now - this.#lastPersistedHeartbeatAt >= HEARTBEAT_PERSIST_INTERVAL_MS
    ) {
      await this.ctx.storage.put(AUTHORITY_STORAGE_KEY, next);
      this.#lastPersistedHeartbeatAt = now;
    }
    socket.send(
      JSON.stringify({
        type: "heartbeat-ack",
        generation: authority.generation,
      }),
    );
  }

  async webSocketClose(socket: WebSocket) {
    await this.#clearCurrentAttachment(socket);
  }

  async webSocketError(socket: WebSocket) {
    await this.#clearCurrentAttachment(socket);
  }

  async #clearCurrentAttachment(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as
      | SocketAttachment
      | undefined;
    if (attachment?.kind === "resident-browser") {
      this.#residentRelay.disconnect(socket);
      return;
    }
    if (attachment?.kind === "daemon")
      await this.#loseDaemonConnection(socket, false);
  }

  async #expireCurrentDaemonConnection() {
    const authority = this.#authority;
    if (authority?.attachmentNonce === undefined) return;
    const socket = this.ctx.getWebSockets().find((candidate) => {
      const attachment = candidate.deserializeAttachment() as
        | DaemonAttachment
        | undefined;
      return (
        attachment?.kind === "daemon" &&
        attachment.generation === authority.generation &&
        attachment.nonce === authority.attachmentNonce
      );
    });
    if (socket !== undefined) await this.#loseDaemonConnection(socket, true);
  }

  async #loseDaemonConnection(socket: WebSocket, close: boolean) {
    const attachment = socket.deserializeAttachment() as
      | DaemonAttachment
      | undefined;
    const authority = this.#authority;
    if (
      attachment?.kind !== "daemon" ||
      authority === undefined ||
      attachment.generation !== authority.generation ||
      attachment.nonce !== authority.attachmentNonce
    )
      return;
    const disconnected: DaemonAuthority = {
      threadId: authority.threadId,
      generation: authority.generation,
      apiKeyId: authority.apiKeyId,
      release: authority.release,
      protocolMajor: authority.protocolMajor,
      terminalVersion: authority.terminalVersion,
      workloadIdentityVersion: authority.workloadIdentityVersion,
      runtimeProvider: authority.runtimeProvider,
      runtimeAssurance: authority.runtimeAssurance,
    };
    this.#authority = disconnected;
    this.#terminalHeartbeat = undefined;
    this.#environmentReady = false;
    this.#appliedEnvironment = undefined;
    this.#disconnectPendingForSocket(socket, true);
    this.#residentRelay.daemonUnavailable();
    try {
      await this.#residentChanges?.beforeSuspend();
    } catch (cause) {
      threadDaemonLogger.warn("Thread Changes disconnect flush failed.", {
        event: "thread_changes_disconnect_flush_failed",
        threadId: authority.threadId,
        cause,
      });
    }
    const threadId = Schema.decodeUnknownSync(ThreadId)(authority.threadId);
    ExecutionWorkspaces.recordResidentTerminalHeartbeat(threadId, undefined);
    if (close)
      try {
        socket.close(1012, "");
      } catch {
        // The failed transport may already be closed.
      }
    if (this.#authority !== disconnected) return;
    await Promise.all([
      this.ctx.storage.put(AUTHORITY_STORAGE_KEY, disconnected),
      this.ctx.storage.delete(APPLIED_ENVIRONMENT_STORAGE_KEY),
    ]);
    if (this.#authority === disconnected) {
      this.#startConnectionRecovery();
      this.#readinessProbe?.settle("changed");
    }
  }

  #startConnectionRecovery() {
    if (this.#connectionRecovery !== undefined) return;
    let recovery: Promise<void>;
    recovery = new Promise<"registered" | "activated" | "timeout">(
      (resolve) => {
        const timeout = setTimeout(
          () => resolve("timeout"),
          ACTIVATION_TIMEOUT_MS,
        );
        this.#connectionRecoveryWake = (reason) => {
          clearTimeout(timeout);
          resolve(reason);
        };
      },
    )
      .then(async (reason) => {
        if (reason !== "timeout") return;
        this.#residentRelay.closeForLifecycle(
          "workspace-paused",
          "on-focus",
          1000,
        );
      })
      .finally(() => {
        if (this.#connectionRecovery === recovery)
          this.#connectionRecovery = undefined;
        this.#connectionRecoveryWake = undefined;
      });
    this.#connectionRecovery = recovery;
  }

  #fenceDaemonSockets(except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      const attachment = socket.deserializeAttachment() as
        | DaemonAttachment
        | undefined;
      if (attachment?.kind === "daemon") {
        this.#disconnectPendingForSocket(
          socket,
          attachment.generation !== undefined &&
            attachment.generation === this.#authority?.generation,
        );
        socket.close(1008, "Daemon connection superseded.");
      }
    }
  }

  #settlePending(requestId: string, response: Response) {
    const pending = this.#pendingRequests.get(requestId);
    if (pending === undefined) return;
    this.#pendingRequests.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(response);
  }

  #disconnectPendingForSocket(socket: WebSocket, sameAuthority: boolean) {
    for (const [requestId, pending] of this.#pendingRequests) {
      if (pending.socket !== socket) continue;
      if (
        sameAuthority &&
        pending.resumable &&
        this.#sameDaemonAuthority(pending.authority) &&
        Date.now() < pending.deadline
      ) {
        pending.socket = undefined;
        continue;
      }
      this.#settlePending(requestId, daemonFailureResponse("unknown"));
    }
  }

  #failAllPending() {
    for (const [requestId, pending] of this.#pendingRequests)
      this.#settlePending(
        requestId,
        daemonFailureResponse(pending.dispatched ? "unknown" : "known"),
      );
  }

  #startRepair(threadId: ThreadId) {
    let repair: Promise<void>;
    repair = (
      this.#environmentActivation ?? this.#activateEnvironment(threadId)
    )
      .then(() =>
        ExecutionWorkspaces.repairChanges(threadId).catch(() => {
          threadDaemonLogger.warn("Thread Changes reconnect repair failed.", {
            event: "thread_changes_reconnect_repair_failed",
            threadId,
          });
        }),
      )
      .catch((cause) => {
        this.#environmentReady = false;
        this.#residentRelay.close("environment-unavailable", "manual", 1012);
        throw cause;
      })
      .finally(() => {
        if (this.#repair === repair) this.#repair = undefined;
        if (this.#isReady()) this.#resumePendingRequests();
      });
    this.#repair = repair;
    void repair.catch(() => undefined);
  }
}
