import { DurableObject } from "cloudflare:workers";
import {
  THREAD_CHANGES_SUBPROTOCOL,
  THREAD_TERMINAL_SUBPROTOCOL,
  type ThreadTerminalServerPhase,
} from "@dx/api";
import { ThreadId, WorkloadIdentityUnauthorized } from "@dx/domain";
import { Effect, Option, Redacted, Schema } from "effect";
import {
  confirmThreadDaemonApiKey,
  mintThreadDaemonApiKey,
  revokeThreadDaemonApiKey,
  threadDaemonApiKeyHash,
  threadDaemonBearer,
  verifyThreadDaemonApiKey,
} from "../auth/daemon-api-key.js";
import { decodeBase64Url, encodeBase64Url } from "../encoding/base64.js";
import { utf8ByteLength, utf8ExceedsBytes } from "../encoding/utf8.js";
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
  DXD_SANDBOX_CHUNK_HEADER,
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
  DxdUpdateMessage,
  type DxdWorkloadIdentityRequest,
  DxdWorkloadIdentityRequestMessage,
  decodeDxdSandboxChunkFrame,
  environmentActivationDigest,
  isDxdSandboxChunkFrame,
} from "../execution/dxd/protocol.js";
import { loadDaemonReleaseMetadata } from "../execution/e2b/daemon-release.js";
import { ExecutionWorkspaces } from "../execution/execution-workspaces.js";
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
import {
  BITBUCKET_GIT_PATH,
  bitbucketRuntimeBroker,
} from "../source-control/bitbucket/runtime.js";
import { readGitHubUserAccessToken } from "../source-control/github/control-plane.js";
import {
  markResidentThreadChangesDirty,
  usableResidentCapture,
} from "../thread-changes/coordinator.js";
import {
  makeThreadChangesRepository,
  type ThreadChangesCaptureLease,
  type ThreadChangesSource,
} from "../thread-changes/repository-d1.js";
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
/** How late a heartbeat may be before a browser's liveness miss is probed. */
const TERMINAL_LIVENESS_GRACE_MS = 500;
/**
 * The probe after such a miss. The heartbeat is already late, so a paused
 * guest is fenced about three seconds after its last heartbeat rather than
 * the four a probe-free fence waits; a live daemon answers in tens of ms.
 */
const TERMINAL_LIVENESS_PROBE_TIMEOUT_MS = 500;
const MAX_PENDING_DAEMON_REQUESTS = 32;
/** How long an `applying` report keeps the next loss and registration quiet. */
const PLANNED_HANDOFF_MS = 10_000;
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
const RESIDENT_READY_STORAGE_KEY = "terminal-resident-ready";

/** When Core first saw a Terminal resident generation ready. */
const ResidentReadyMarker = Schema.Struct({
  residentGeneration: Schema.String,
  at: Schema.Number,
});
type ResidentReadyMarker = typeof ResidentReadyMarker.Type;

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
  /**
   * SHA-256 of the key `apiKeyId` names. Every revocation goes through this
   * object and replaces or drops the authority with it, so a registration is
   * admitted by this hash without D1.
   */
  readonly apiKeyHash?: string;
  readonly release: typeof DXD_RELEASE;
  readonly protocolMajor: typeof DXD_PROTOCOL_MAJOR;
  readonly terminalVersion: typeof DXD_TERMINAL_VERSION;
  readonly workloadIdentityVersion: typeof DXD_WORKLOAD_IDENTITY_VERSION;
  readonly runtimeProvider: "local" | "e2b" | "cloudflare";
  readonly runtimeAssurance: "dx_dxd_channel_v1" | "dx_provider_attested_v1";
  readonly attachmentNonce?: string;
  readonly lastSeen?: number;
  /** Release the connected daemon reported; differs from `release` until it updates. */
  readonly daemonRelease?: string;
  /** The connected daemon waits for a `chunk-ack` per `DXF1` frame. */
  readonly chunkAcks?: boolean;
}

interface DaemonAttachment {
  readonly kind: "daemon";
  /** Admitted by stored hash; D1 has not confirmed the key yet. */
  readonly confirming?: true;
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
  /** A sandbox chunk that dxd is still sending as consecutive `DXF1` frames. */
  sandboxChunk?: SandboxChunkAssembly;
}

interface SandboxChunkAssembly {
  readonly version: string;
  readonly sizeBytes: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  received: number;
}

type ReadinessProbeResult = "ready" | "changed" | "timeout" | "drained";

const randomBase64Url = (byteLength: number) =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

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
  /** Outcome of the in-flight `#readinessProbe`, shared by concurrent callers. */
  #readinessProbeResult?: Promise<ReadinessProbeResult>;
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
  /**
   * When this instance last heard the daemon itself. Unlike `lastSeen`, it is
   * never restored after hibernation, so a paused guest cannot look live.
   */
  #lastHeartbeatAt?: number;
  /** Pending D1 confirmations for daemons admitted by stored key hash. */
  readonly #daemonConfirmations = new WeakMap<WebSocket, Promise<boolean>>();
  /** When the scheduled alarm next checks the daemon heartbeat lease. */
  #leaseCheckAt?: number;
  #terminalResetRequired = false;
  /**
   * Until when the daemon's own release swap (`update-status: applying`)
   * explains a closed socket: attached browsers are reattached silently.
   */
  #plannedHandoffUntil?: number;
  readonly #readinessWaiters = new Set<() => void>();
  readonly #terminalWaiters = new Set<(state: DxdTerminalHeartbeat) => void>();
  readonly #pendingRequests = new Map<string, PendingDaemonRequest>();
  readonly #pendingWorkloadIdentityRequests = new Set<string>();
  #observingChanges?: Promise<void>;
  #changesObserved = false;
  /** A Thread's Changes source is immutable once it exists. */
  #changesSource?: ThreadChangesSource;
  /** Last fingerprint seen in D1 or published here; `null` = no capture yet. */
  #changesFingerprint?: string | null;
  /** The latest resident dirty mark; publication must not overtake it. */
  #changesMarked: Promise<void> = Promise.resolve();
  /** The capture lease the next candidate publishes under. */
  #heldCapture?: ThreadChangesCaptureLease;
  /** Candidates publish one at a time, so they never contend for the lease. */
  #publishingChanges: Promise<void> = Promise.resolve();
  /** The resident Core last saw become ready, and when. */
  #residentReady?: ResidentReadyMarker;
  /**
   * When the workspace's processes last started, from the latest daemon
   * activation; only providers whose pause restarts processes report it.
   */
  #processesStartedAt?: number;

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
      const storedResidentReady = Schema.decodeUnknownOption(
        ResidentReadyMarker,
      )(await ctx.storage.get(RESIDENT_READY_STORAGE_KEY));
      this.#residentReady = Option.isSome(storedResidentReady)
        ? storedResidentReady.value
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
      const daemonLive =
        authority?.lastSeen !== undefined &&
        daemonSocket !== undefined &&
        Date.now() - authority.lastSeen <= DXD_HEARTBEAT_LEASE_MS;
      let restoredWhilePaused = false;
      for (const socket of ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as
          | SocketAttachment
          | undefined;
        if (attachment?.kind !== "resident-browser") continue;
        const transport = this.#residentTransport(
          attachment.threadId,
          () => {},
          socket,
        );
        if (attachment.terminal.requested && !daemonLive) {
          // Paused or gone: an immediate reconnect would make a retained,
          // hidden Terminal wake the workspace. Wait for the daemon instead.
          if (
            this.#residentRelay.restore(
              socket,
              attachment.terminal,
              transport,
              true,
            )
          )
            restoredWhilePaused = true;
          else this.#closeResidentBrowserForPause(socket);
          continue;
        }
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
          !this.#residentRelay.restore(socket, attachment.terminal, transport)
        )
          this.#closeResidentBrowserForReconnect(socket);
      }
      // A lost connection is known: tell the restored attachments now.
      if (restoredWhilePaused && authority?.attachmentNonce === undefined)
        this.#residentRelay.workspacePaused();
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
    const now = Date.now();
    this.#leaseCheckAt = undefined;
    const expired = await this.#expiredDaemonSocket(now);
    if (expired !== undefined) await this.#loseDaemonConnection(expired, true);
    const attempt = await this.#readDaemonActivationAttempt();
    let attemptCheckAt: number | undefined;
    if (attempt !== undefined) {
      if (Date.now() < attempt.deadlineAt)
        attemptCheckAt = attempt.deadlineAt + 1_000;
      else if (
        this.#activation !== undefined &&
        this.#activation.id === attempt.activationId
      )
        attemptCheckAt = Date.now() + 30_000;
      else {
        await Promise.all(
          attempt.submissions.map((observation) =>
            this.#recordDaemonActivationFailure(attempt, observation),
          ),
        );
        await this.ctx.storage.delete(ACTIVATION_ATTEMPT_STORAGE_KEY);
      }
    }
    if (attemptCheckAt === undefined && this.#leaseCheckAt === undefined)
      await this.ctx.storage.deleteAlarm();
    else
      await this.ctx.storage.setAlarm(
        Math.min(
          ...[attemptCheckAt, this.#leaseCheckAt].filter(
            (value): value is number => value !== undefined,
          ),
        ),
      );
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
      // Start after the assignment below, so the finally can clear it.
      await undefined;
      try {
        while (
          this.#changesObserved &&
          this.#currentDaemonSocket() === socket
        ) {
          this.#changesObserved = false;
          this.#changesSource ??=
            await makeThreadChangesRepository(db).source(threadId);
          // Source preparation has not finished: nothing to capture against yet.
          if (this.#changesSource === undefined) return;
          // With a known fingerprint the refresh goes out before the D1 mark, so
          // the capture overlaps it; publication waits for the mark.
          const token = crypto.randomUUID();
          const expected = this.#changesFingerprint;
          const early =
            expected === undefined
              ? undefined
              : ({
                  type: "changes-refresh",
                  token,
                  source: {
                    baseline: this.#changesSource.baseline,
                    defaultBranch: this.#changesSource.defaultBranch,
                  },
                  ...(expected === null
                    ? {}
                    : { expectedFingerprint: expected }),
                } satisfies DxdChangesRefresh);
          if (early !== undefined) socket.send(JSON.stringify(early));
          const marking = markResidentThreadChangesDirty({
            db,
            threadId,
            source: this.#changesSource,
            token,
            ...(this.#heldCapture === undefined
              ? {}
              : { held: this.#heldCapture }),
          });
          this.#changesMarked = marking.then(
            () => undefined,
            () => undefined,
          );
          const { refresh, capture } = await marking;
          this.#heldCapture = capture;
          this.#changesFingerprint = refresh.expectedFingerprint ?? null;
          if (this.#currentDaemonSocket() !== socket) return;
          // Another publisher moved the fingerprint: ask again with D1's value
          // (same token), so an unchanged capture can still be confirmed.
          if (
            early === undefined ||
            early.expectedFingerprint !== refresh.expectedFingerprint
          )
            socket.send(JSON.stringify(refresh));
          this.#notifyChanges(threadId);
        }
      } finally {
        // Cleared in the same turn as the last flag check: a hint arriving
        // after it starts a new loop instead of being lost.
        this.#observingChanges = undefined;
      }
    })().catch(() => {
      threadDaemonLogger.warn(
        "Changes observation could not request a capture.",
        {
          event: "thread_changes_observation_failed",
          threadId,
        },
      );
    });
    this.ctx.waitUntil(this.#observingChanges);
  }

  #publishChanges(
    socket: WebSocket,
    threadId: ThreadId,
    candidate: DxdChangesCandidateEvent,
  ) {
    const published = this.#publishingChanges.then(async () => {
      await this.#changesMarked;
      await this.#publishCandidate(socket, threadId, candidate);
    });
    this.#publishingChanges = published.catch(() => undefined);
    return published;
  }

  async #publishCandidate(
    socket: WebSocket,
    threadId: ThreadId,
    candidate: DxdChangesCandidateEvent,
  ) {
    if (this.env.DB === undefined || this.env.DX_STORAGE === undefined) return;
    // The next candidate publishes under the lease the latest mark took. Its
    // read decides: a candidate for another refresh (a Files save, an older
    // hint) is superseded and asks again with the newest token.
    const held = this.#heldCapture;
    this.#heldCapture = undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.#currentDaemonSocket() !== socket) {
        await held?.release().catch(() => undefined);
        return;
      }
      const capture =
        attempt === 0 && usableResidentCapture(held) ? held : undefined;
      if (attempt === 0 && held !== undefined && capture === undefined)
        await held.release().catch(() => undefined);
      const outcome = await publishThreadChangesResidentCandidate({
        db: this.env.DB,
        bucket: this.env.DX_STORAGE,
        threadId,
        candidate,
        ...(capture === undefined ? {} : { capture }),
        onCommitted: (fingerprint) => {
          this.#changesFingerprint = fingerprint;
          this.#notifyChanges(threadId);
          this.ctx.waitUntil(
            publishRealtimeInvalidation(
              this.env,
              threadId,
              "changes.invalidated",
            ).catch(() => undefined),
          );
        },
      });
      if (outcome === "published" || outcome === "unchanged") return;
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
    // A ready daemon needs only the live round trip an activation would
    // make; skipping the activation record keeps storage and D1 writes off
    // every Files request.
    if (
      this.#authority?.threadId === threadId &&
      this.#activation === undefined &&
      this.#isReady()
    ) {
      const result = await this.#probeReadiness();
      if (
        result === "ready" &&
        this.#authority?.threadId === threadId &&
        this.#isTransportReady()
      )
        return true;
    }
    const activation = this.#activateWithRetry(threadId);
    let removeWaiter: () => void = () => undefined;
    const transport = new Promise<boolean>((resolve) => {
      const ready = () => {
        if (
          this.#authority?.threadId !== threadId ||
          !this.#isTransportReady() ||
          !this.#isHeartbeatFresh()
        )
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
    if (stored?.activationId === activation.id) {
      await this.ctx.storage.delete(ACTIVATION_ATTEMPT_STORAGE_KEY);
      await this.#scheduleAlarm();
    }
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
        await this.#scheduleAlarm(attempt.deadlineAt + 1_000);
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

  /** `overdueTimeoutMs`: the caller already saw a heartbeat arrive late. */
  async #probeReadiness(overdueTimeoutMs?: number) {
    const socket = this.#currentDaemonSocket();
    const authority = this.#authority;
    if (socket === undefined || authority?.attachmentNonce === undefined)
      return "changed" as const;
    const nonce = authority.attachmentNonce;
    // Silent for two heartbeat intervals, as the browser's liveness check
    // sees it: the guest is paused or gone, and a probe would only add its
    // timeout to the wake.
    if (
      this.#lastHeartbeatAt !== undefined &&
      Date.now() - this.#lastHeartbeatAt >= 2 * DXD_HEARTBEAT_INTERVAL_MS
    ) {
      await this.#loseDaemonConnection(socket, true);
      return "timeout" as const;
    }
    // Concurrent callers share one round trip on the same connection.
    const inFlight = this.#readinessProbe;
    if (
      inFlight?.socket === socket &&
      inFlight.nonce === nonce &&
      this.#readinessProbeResult !== undefined
    )
      return this.#readinessProbeResult;
    // A busy daemon still heartbeats on its control lane, so only a daemon
    // heard recently gets the normal request budget for work ahead of the
    // ping; a silent one (a paused guest) is fenced after the short probe.
    const timeoutMs =
      overdueTimeoutMs ??
      (this.#pendingRequests.size === 0 || !this.#isHeartbeatFresh()
        ? READINESS_PROBE_TIMEOUT_MS
        : DAEMON_REQUEST_TIMEOUT_MS);
    const settled = new Promise<ReadinessProbeResult>((resolve) => {
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
    this.#readinessProbeResult = settled;
    const result = await settled;
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
      const runtime = Effect.runSync(loadRuntimeConfiguration(this.env));
      const existing = this.#authority;
      let credential:
        | { id: string; key: Redacted.Redacted<string> }
        | undefined;
      let authority: DaemonAuthority;
      if (existing?.threadId === threadId) {
        // One key and one generation per Thread for its whole life. Only
        // Core's own expected versions are refreshed here.
        authority = {
          ...existing,
          release: DXD_RELEASE,
          protocolMajor: DXD_PROTOCOL_MAJOR,
          terminalVersion: DXD_TERMINAL_VERSION,
          workloadIdentityVersion: DXD_WORKLOAD_IDENTITY_VERSION,
          // Deployed: the pinned provider, corrected after installation.
          runtimeProvider:
            runtime.executionAdapter === "local"
              ? "local"
              : existing.runtimeProvider === "local"
                ? runtime.executionAdapter
                : existing.runtimeProvider,
        };
        if (authority !== existing) {
          this.#authority = authority;
          await this.ctx.storage.put(AUTHORITY_STORAGE_KEY, authority);
        }
      } else {
        credential = await mintThreadDaemonApiKey(this.env, threadId);
        if (signal.aborted || epoch !== this.#drainEpoch) {
          await revokeThreadDaemonApiKey(this.env, credential.id);
          throw new Error("activation deadline exceeded");
        }
        authority = {
          threadId,
          generation: Schema.decodeUnknownSync(DaemonGenerationSchema)(
            randomBase64Url(24),
          ),
          apiKeyId: credential.id,
          apiKeyHash: threadDaemonApiKeyHash(Redacted.value(credential.key)),
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
        if (existing !== undefined)
          await revokeThreadDaemonApiKey(this.env, existing.apiKeyId);
      }
      if (signal.aborted || epoch !== this.#drainEpoch)
        throw new Error("activation deadline exceeded");
      stage = "install";
      const installation = await ExecutionWorkspaces.ensureDaemon({
        threadId,
        endpoint,
        signal,
        credential,
        mintCredential: async () => {
          const minted = await mintThreadDaemonApiKey(this.env, threadId);
          const apiKeyHash = threadDaemonApiKeyHash(Redacted.value(minted.key));
          const current = this.#authority;
          if (current?.threadId === threadId) {
            const previousKeyId = current.apiKeyId;
            this.#authority = { ...current, apiKeyId: minted.id, apiKeyHash };
            await this.ctx.storage.put(AUTHORITY_STORAGE_KEY, this.#authority);
            if (previousKeyId !== minted.id)
              await revokeThreadDaemonApiKey(this.env, previousKeyId);
          }
          return minted;
        },
        // A resumed guest still runs its daemon, which reconnects on its own
        // within a few hundred milliseconds. Give it that chance before any
        // guest command touches the installation.
        awaitRegistration: (timeoutMs) => this.#awaitTransport(timeoutMs),
      });
      if (epoch !== this.#drainEpoch)
        throw new Error("activation cancelled by drain");
      this.#processesStartedAt = installation.processesStartedAt;
      // A deployment may run several Orb providers; workload identity names
      // the one this Thread's workspace is pinned to.
      const pinned = this.#authority;
      if (
        installation.provider !== undefined &&
        pinned?.threadId === threadId &&
        pinned.runtimeProvider !== installation.provider
      ) {
        this.#authority = {
          ...pinned,
          runtimeProvider: installation.provider,
        };
        await this.ctx.storage.put(AUTHORITY_STORAGE_KEY, this.#authority);
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

  /** Resolve true once a daemon registers, or false after `timeoutMs`. */
  #awaitTransport(timeoutMs: number): Promise<boolean> {
    if (this.#isTransportReady()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      const ready = () => {
        clearTimeout(timeout);
        this.#readinessWaiters.delete(ready);
        resolve(true);
      };
      this.#readinessWaiters.add(ready);
      timeout = setTimeout(() => {
        this.#readinessWaiters.delete(ready);
        resolve(false);
      }, timeoutMs);
    });
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
    if (
      state.state === "ready" &&
      this.#residentReady?.residentGeneration !== state.residentGeneration
    ) {
      this.#residentReady = {
        residentGeneration: state.residentGeneration,
        at: Date.now(),
      };
      void this.ctx.storage
        .put(RESIDENT_READY_STORAGE_KEY, this.#residentReady)
        .catch(() => undefined);
    }
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
    if (utf8ExceedsBytes(encoded, DXD_MAX_CONTROL_FRAME_BYTES))
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
      exitedTerminal: async (stop) => {
        while (!stop()) {
          const state =
            this.#currentDaemonSocket() === undefined
              ? undefined
              : this.#terminalHeartbeat;
          if (state?.state === "exited") return state;
          await new Promise<void>((resolve) =>
            this.#terminalWaiters.add(() => resolve()),
          );
        }
        return new Promise<DxdTerminalHeartbeat>(() => undefined);
      },
      refreshEnvironment: async () => {
        await this.#activateEnvironment(threadId);
        return this.#awaitTerminalHeartbeat();
      },
      // The resident's shell was ready before the workspace's processes last
      // started, so it died with a provider wake that restarts processes
      // (Containers), not on its own: open a new one, as the user would.
      restartedWithWorkspace: (residentGeneration) =>
        this.#processesStartedAt !== undefined &&
        this.#residentReady?.residentGeneration === residentGeneration &&
        this.#residentReady.at < this.#processesStartedAt,
      checkLiveness: () => this.#checkTerminalLiveness(threadId),
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

  /**
   * A present browser's Terminal missed a heartbeat. The daemon heard within
   * one interval (plus grace) is live and only the browser leg was late;
   * otherwise one readiness round trip decides, and a silent daemon is fenced
   * here, on the browser's existing socket, instead of after the browser
   * reconnects through a cold Worker.
   */
  async #checkTerminalLiveness(threadId: ThreadId) {
    const startedAt = Date.now();
    const silentMs =
      this.#lastHeartbeatAt === undefined
        ? undefined
        : startedAt - this.#lastHeartbeatAt;
    let outcome: "fresh" | "ready" | "fenced";
    if (
      silentMs !== undefined &&
      silentMs < DXD_HEARTBEAT_INTERVAL_MS + TERMINAL_LIVENESS_GRACE_MS
    )
      outcome = "fresh";
    else if (this.#currentDaemonSocket() === undefined) {
      await this.#expireCurrentDaemonConnection();
      outcome = "fenced";
    } else
      outcome =
        (await this.#probeReadiness(TERMINAL_LIVENESS_PROBE_TIMEOUT_MS)) ===
        "ready"
          ? "ready"
          : "fenced";
    threadDaemonLogger.info("Thread Terminal liveness check.", {
      event: "thread_daemon_liveness_check",
      threadId,
      outcome,
      silentMs,
      checkMs: Date.now() - startedAt,
    });
    return outcome !== "fenced";
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

  #closeResidentBrowserForPause(socket: WebSocket) {
    try {
      socket.send(
        JSON.stringify({
          v: 1,
          type: "error",
          code: "workspace-paused",
          retry: "on-focus",
        }),
      );
      socket.close(1000, "");
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
    // Terminal input holds no Changes lease: dxd's filesystem observer
    // reports every mutation it causes, so captures stay complete.
    await ExecutionWorkspaces.recordResidentTerminalInput(threadId);
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
      if (utf8ExceedsBytes(body, DXD_MAX_REQUEST_FRAME_BYTES))
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
      operation.operation === "files.read" ||
      operation.operation === "files.readSandbox";
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
    if (utf8ExceedsBytes(frame, maximumBytes))
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
          operation.operation === "environment.check" ||
          operation.operation === "files.list" ||
          operation.operation === "files.read" ||
          operation.operation === "files.readSandbox",
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
          pending.operation.operation !== "environment.check" &&
          pending.operation.operation !== "files.list" &&
          pending.operation.operation !== "files.read" &&
          pending.operation.operation !== "files.readSandbox" &&
          !this.#isReady())
      )
        continue;
      const frame = JSON.stringify({
        type: "request",
        generation: pending.authority.generation,
        requestId,
        operation: pending.operation,
      });
      if (utf8ExceedsBytes(frame, pending.maximumBytes)) {
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
    // Independent D1 reads: a wake waits for the slowest, not their sum.
    const db = await Effect.runPromise(decodeD1Binding(this.env.DB));
    // Every bitbucket.org remote routes through the dx gateway while the
    // Thread owner has an active Bitbucket connection.
    const [snapshot, signing, bitbucketConnection] = await Promise.all([
      Effect.runPromise(resolveExecutionEnvironment(this.env, threadId)),
      Effect.runPromise(resolveExecutionSigningPlan(this.env, threadId)),
      db
        .prepare(
          `SELECT 1 AS connected FROM threads t
             JOIN bitbucket_connection c ON c.user_id = t.owner_user_id
            WHERE t.id = ? AND c.status = 'active' LIMIT 1`,
        )
        .bind(threadId)
        .first<{ connected: number }>(),
    ]);
    const gatewayOrigin = new URL(this.env.DX_AUTH_URL as string).origin;
    const bitbucketGateway =
      bitbucketConnection !== null && gatewayOrigin.startsWith("https://")
        ? { origin: gatewayOrigin }
        : undefined;
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
    // Digest first: a daemon that already holds this exact environment
    // answers a 4 KiB control frame instead of receiving up to 14 MiB again.
    const digest = await environmentActivationDigest(operation);
    const checked = await this.#dispatchDaemonOperation(
      authority,
      { operation: "environment.check", generation, digest },
      DXD_MAX_REQUEST_FRAME_BYTES,
      ACTIVATION_TIMEOUT_MS,
    );
    if (!checked.ok) throw new Error("environment unavailable");
    let result = Schema.decodeUnknownSync(DxdEnvironmentActivateResult)(
      await checked.json(),
      { onExcessProperty: "error" },
    );
    if (result.generation !== generation || result.kind === "superseded")
      throw new Error("environment unavailable");
    if (result.kind !== "unchanged") {
      const response = await this.#dispatchDaemonOperation(
        authority,
        operation,
        DXD_MAX_ENVIRONMENT_REQUEST_FRAME_BYTES,
        ACTIVATION_TIMEOUT_MS,
      );
      if (!response.ok) throw new Error("environment unavailable");
      result = Schema.decodeUnknownSync(DxdEnvironmentActivateResult)(
        await response.json(),
        { onExcessProperty: "error" },
      );
    }
    if (
      result.generation !== generation ||
      result.kind === "unavailable" ||
      result.kind === "superseded" ||
      result.kind === "missing"
    )
      throw new Error("environment unavailable");
    if (result.kind === "resume-timeout")
      threadDaemonLogger.warn("Thread resume hook exceeded its time bound.", {
        event: "thread_resume_timeout",
        threadId,
      });
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

  #inPlannedHandoff() {
    return (
      this.#plannedHandoffUntil !== undefined &&
      Date.now() < this.#plannedHandoffUntil
    );
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

  /**
   * The daemon was heard within two heartbeat intervals. A paused guest's
   * socket can stay open for the whole lease; dispatching to it would wait
   * out a request timeout, so a stale transport is probed first instead.
   */
  #isHeartbeatFresh(now = Date.now()) {
    return (
      this.#lastHeartbeatAt !== undefined &&
      now - this.#lastHeartbeatAt <= 2 * DXD_HEARTBEAT_INTERVAL_MS + 1_000
    );
  }

  /**
   * Act on an expired heartbeat lease instead of waiting for the next
   * request: a paused guest's socket stays open, and an attached Terminal
   * that is not in view relies on this object to learn the daemon is gone.
   * The check is a storage alarm, which survives hibernation and resets; an
   * in-memory timer does not. Heartbeats only move the in-memory time, so a
   * live daemon costs one alarm write per lease.
   */
  #armDaemonLease() {
    if (this.#leaseCheckAt !== undefined && this.#leaseCheckAt > Date.now())
      return;
    this.#leaseCheckAt = Date.now() + DXD_HEARTBEAT_LEASE_MS;
    void this.#scheduleAlarm().catch(() => undefined);
  }

  /** Point the single alarm at the earliest lease check or activation deadline. */
  async #scheduleAlarm(attemptCheckAt?: number) {
    const attempt =
      attemptCheckAt === undefined
        ? await this.#readDaemonActivationAttempt()
        : undefined;
    const next = [
      attemptCheckAt ??
        (attempt === undefined ? undefined : attempt.deadlineAt + 1_000),
      this.#leaseCheckAt,
    ].filter((value): value is number => value !== undefined);
    if (next.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...next));
  }

  /** Returns the daemon socket to drop when the lease expired, if any. */
  async #expiredDaemonSocket(now: number) {
    const authority = this.#authority;
    if (authority?.attachmentNonce === undefined) return undefined;
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
    if (socket === undefined) return undefined;
    // A fresh instance has not heard the daemon itself; the persisted time
    // lags the last heartbeat by at most one persistence interval.
    let deadline: number | undefined =
      this.#lastHeartbeatAt === undefined
        ? undefined
        : this.#lastHeartbeatAt + DXD_HEARTBEAT_LEASE_MS;
    if (deadline === undefined) {
      const stored = (await this.ctx.storage.get(AUTHORITY_STORAGE_KEY)) as
        | { readonly lastSeen?: number }
        | undefined;
      if (stored?.lastSeen !== undefined)
        deadline =
          stored.lastSeen +
          DXD_HEARTBEAT_LEASE_MS +
          HEARTBEAT_PERSIST_INTERVAL_MS;
    }
    if (deadline !== undefined && now < deadline) {
      this.#leaseCheckAt = deadline;
      return undefined;
    }
    threadDaemonLogger.info("Thread daemon heartbeat lease expired.", {
      event: "thread_daemon_lease_expired",
      threadId: authority.threadId,
      silentMs:
        this.#lastHeartbeatAt === undefined
          ? undefined
          : now - this.#lastHeartbeatAt,
      browserSessions: this.#residentRelay.sessionCount,
    });
    return socket;
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

  /**
   * Native Git credentials follow the Thread owner, not the Thread's source:
   * github.com receives the owner's GitHub App user token, and the dx
   * Bitbucket gateway receives a short-lived lease for the owner's Bitbucket
   * connection. Provider access decides which repositories either reaches.
   */
  async #issueNativeGitCredential(
    threadId: string,
    request: Extract<
      DxdWorkloadIdentityRequest["request"],
      { kind: "git-credential" }
    >,
  ) {
    const db = await Effect.runPromise(decodeD1Binding(this.env.DB));
    const thread = await db
      .prepare(
        "SELECT owner_user_id FROM threads WHERE id = ? AND lifecycle_state = 'active' LIMIT 1",
      )
      .bind(threadId)
      .first<{ owner_user_id: string }>();
    if (thread === null) return undefined;
    const host = request.host.toLowerCase();
    if (host === "github.com") {
      const password = await readGitHubUserAccessToken(
        this.env,
        db,
        thread.owner_user_id,
      );
      threadDaemonLogger.info("Native GitHub credential issued.", {
        event: "native_git_credential",
        threadId,
        actorUserId: thread.owner_user_id,
        provider: "github",
      });
      return { username: "x-access-token", password };
    }
    const gateway = new URL(this.env.DX_AUTH_URL as string);
    if (
      host !== gateway.host.toLowerCase() ||
      !`/${request.path ?? ""}`.startsWith(`${BITBUCKET_GIT_PATH}/`)
    )
      return undefined;
    const environment = await Effect.runPromise(
      bitbucketRuntimeBroker(db, this.env).withCommandEnvironment(
        threadId,
        thread.owner_user_id,
        { operation: "contents-push", invocationSource: "git-helper" },
        (value) => Effect.succeed(value),
      ),
    );
    const password = environment.DX_BITBUCKET_GIT_TOKEN;
    return password === undefined ? undefined : { username: "dx", password };
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
          // The schema already restricts the payload to base64url.
          const payload = decodeBase64Url(message.request.payloadBase64);
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
          ).catch((cause: unknown) => {
            const reason = (cause as { readonly reason?: unknown } | undefined)
              ?.reason;
            threadDaemonLogger.warn("Native Git credential unavailable.", {
              event: "native_git_credential",
              threadId: authority.threadId,
              failure:
                typeof reason === "string"
                  ? reason
                  : cause instanceof Error
                    ? cause.name
                    : "unknown",
            });
            throw cause;
          });
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
    if (utf8ExceedsBytes(encoded, DXD_MAX_WORKLOAD_IDENTITY_FRAME_BYTES)) {
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

  /**
   * Name the release this Core pins after every registration. The daemon
   * compares its digest with the image it runs; when they differ it
   * downloads and verifies in the background and swaps at a quiet moment,
   * keeping its shell. A missing release configuration (local mode) leaves
   * the daemon as it is.
   */
  async #requestDaemonUpdate(
    socket: WebSocket,
    authority: DaemonAuthority,
    daemonRelease: string,
  ) {
    let release: { url: string; sha256: string };
    try {
      release = await loadDaemonReleaseMetadata(this.env);
    } catch {
      return;
    }
    const message = Schema.decodeUnknownOption(DxdUpdateMessage)({
      type: "update",
      generation: authority.generation,
      url: release.url,
      sha256: release.sha256,
      release: DXD_RELEASE,
    });
    if (Option.isNone(message)) return;
    if (daemonRelease !== DXD_RELEASE)
      threadDaemonLogger.info("Thread daemon update requested.", {
        event: "thread_daemon_update_requested",
        threadId: authority.threadId,
        from: daemonRelease,
        to: DXD_RELEASE,
      });
    try {
      socket.send(JSON.stringify(message.value));
    } catch {
      // The socket closes on its own; the next registration retries.
    }
  }

  /**
   * Admit a daemon by the hash of the Thread's one key. An authority from
   * before hashes were kept proves the key once through D1 and learns its
   * hash. D1 then confirms the key row, owner and active lifecycle behind the
   * admission; a failed confirmation closes the socket and forgets the hash.
   */
  async #acceptDaemon(request: Request) {
    const authority = this.#authority;
    const key = threadDaemonBearer(request.headers.get("authorization"));
    if (
      request.headers.get("x-dx-daemon-ingress") !== "1" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      authority === undefined
    )
      return new Response(null, { status: 404 });
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      request.headers.get("x-dx-thread-id"),
    );
    if (Option.isNone(threadId) || threadId.value !== authority.threadId)
      return new Response(null, { status: 404 });
    if (key === undefined) return new Response(null, { status: 401 });
    const hash = threadDaemonApiKeyHash(key);
    let learned = false;
    if (authority.apiKeyHash === undefined) {
      const verified = await verifyThreadDaemonApiKey(
        this.env,
        threadId.value,
        request.headers.get("authorization"),
      );
      if (verified?.keyId !== authority.apiKeyId)
        return new Response(null, { status: 401 });
      learned = true;
    } else if (hash !== authority.apiKeyHash)
      return new Response(null, { status: 401 });
    // The authority may have been replaced while this request waited.
    const current = this.#authority;
    if (
      current?.threadId !== authority.threadId ||
      current.apiKeyId !== authority.apiKeyId
    )
      return new Response(null, { status: 401 });
    if (learned && current.apiKeyHash === undefined) {
      this.#authority = { ...current, apiKeyHash: hash };
      await this.ctx.storage.put(AUTHORITY_STORAGE_KEY, this.#authority);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      kind: "daemon",
      ...(learned ? {} : { confirming: true }),
    } satisfies DaemonAttachment);
    this.ctx.acceptWebSocket(server);
    if (!learned) {
      // The upgrade does not wait for D1, but no daemon message is handled
      // until D1 confirms the key: a revoked key fails closed.
      const confirmation = this.#confirmDaemonKey(
        server,
        threadId.value,
        authority.apiKeyId,
      );
      this.#daemonConfirmations.set(server, confirmation);
      this.ctx.waitUntil(confirmation);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async #confirmDaemonKey(
    socket: WebSocket,
    threadId: ThreadId,
    keyId: string,
  ): Promise<boolean> {
    let confirmed: boolean;
    try {
      confirmed = await confirmThreadDaemonApiKey(this.env, threadId, keyId);
    } catch {
      confirmed = false;
    }
    if (confirmed) {
      socket.serializeAttachment({ kind: "daemon" } satisfies DaemonAttachment);
      this.#daemonConfirmations.delete(socket);
      return true;
    }
    threadDaemonLogger.warn("Thread daemon key confirmation failed.", {
      event: "thread_daemon_key_unconfirmed",
      threadId,
    });
    const current = this.#authority;
    if (current?.apiKeyId === keyId && current.apiKeyHash !== undefined) {
      // The next registration proves the key through D1 again.
      const { apiKeyHash: _, ...withoutHash } = current;
      this.#authority = withoutHash;
      await this.ctx.storage.put(AUTHORITY_STORAGE_KEY, withoutHash);
    }
    if (this.#currentDaemonSocket() === socket)
      await this.#loseDaemonConnection(socket, true);
    else
      try {
        socket.close(1008, "Daemon key rejected.");
      } catch {
        // Already closed.
      }
    this.#daemonConfirmations.delete(socket);
    return false;
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
    if (utf8ExceedsBytes(body, DXD_MAX_CONTROL_FRAME_BYTES))
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

  async webSocketMessage(
    socket: WebSocket,
    frame: string | ArrayBuffer,
  ): Promise<void> {
    const admission = socket.deserializeAttachment() as
      | SocketAttachment
      | undefined;
    if (admission?.kind === "daemon" && admission.confirming === true) {
      // Hold the daemon's messages until D1 confirms its key. A confirmation
      // lost to an object restart cannot be awaited: fail closed.
      const confirmation = this.#daemonConfirmations.get(socket);
      if (confirmation === undefined) {
        try {
          socket.close(1008, "Daemon key unconfirmed.");
        } catch {
          // Already closed.
        }
        return;
      }
      if (await confirmation) return this.webSocketMessage(socket, frame);
      return;
    }
    const frameBytes =
      typeof frame === "string" ? utf8ByteLength(frame) : frame.byteLength;
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
      if (
        isDxdSandboxChunkFrame(
          new Uint8Array(frame, 0, Math.min(8, frameBytes)),
        )
      ) {
        // The daemon holds its next chunk frames until this one is counted.
        if (authority.chunkAcks === true)
          socket.send(JSON.stringify({ type: "chunk-ack" }));
        this.#settleSandboxChunk(socket, authority, frame);
        return;
      }
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
      // The daemon carries no generation: this object assigns one per
      // authority and the daemon echoes it. An older release is admitted when
      // its protocol matches and is then asked to update itself in place.
      if (
        authority === undefined ||
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
      const next: DaemonAuthority = {
        ...authority,
        attachmentNonce: nonce,
        lastSeen: Date.now(),
        daemonRelease: control.value.release,
        chunkAcks: control.value.capabilities.files !== undefined,
      };
      this.#authority = next;
      this.#lastPersistedHeartbeatAt = next.lastSeen;
      this.#lastHeartbeatAt = next.lastSeen;
      this.#armDaemonLease();
      this.#terminalHeartbeat = undefined;
      this.#environmentReady = false;
      this.#appliedEnvironment = undefined;
      this.#terminalResetRequired = true;
      this.#residentRelay.daemonConnectionReset(this.#inPlannedHandoff());
      this.#plannedHandoffUntil = undefined;
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
      await this.#requestDaemonUpdate(socket, next, control.value.release);
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
    if (Option.isSome(control) && control.value.type === "update-status") {
      // The daemon hands its PTY and replay to the new image and registers
      // again within a second: a planned swap, not a loss.
      if (control.value.status === "applying")
        this.#plannedHandoffUntil = Date.now() + PLANNED_HANDOFF_MS;
      threadDaemonLogger[control.value.status === "failed" ? "warn" : "info"](
        "Thread daemon update status.",
        {
          event: "thread_daemon_update_status",
          threadId: authority.threadId,
          release: control.value.release,
          status: control.value.status,
        },
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
        this.#lastHeartbeatAt = this.#authority.lastSeen;
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
    this.#lastHeartbeatAt = now;
    this.#armDaemonLease();
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
      ...(authority.apiKeyHash === undefined
        ? {}
        : { apiKeyHash: authority.apiKeyHash }),
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
    const notifiedBrowsers = this.#residentRelay.daemonUnavailable(
      this.#inPlannedHandoff(),
    );
    threadDaemonLogger.info("Thread daemon connection lost.", {
      event: "thread_daemon_connection_lost",
      threadId: authority.threadId,
      close,
      notifiedBrowsers,
    });
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
        if (reason === "timeout") this.#residentRelay.workspacePaused();
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

  /**
   * Hand a sandbox chunk to its waiting read as the response body. dxd sends
   * a chunk as one or more `DXF1` frames with consecutive offsets so other
   * traffic interleaves; a single-frame chunk is passed through uncopied.
   */
  #settleSandboxChunk(
    socket: WebSocket,
    authority: DaemonAuthority,
    frame: ArrayBuffer,
  ) {
    let decoded: ReturnType<typeof decodeDxdSandboxChunkFrame>;
    try {
      decoded = decodeDxdSandboxChunkFrame(frame);
    } catch {
      socket.close(1008, "Invalid daemon message.");
      return;
    }
    const { header, bytes } = decoded;
    const pending = this.#pendingRequests.get(header.requestId);
    if (
      pending?.socket !== socket ||
      header.generation !== authority.generation ||
      pending.operation.operation !== "files.readSandbox"
    )
      return;
    const requested = pending.operation;
    const assembly = pending.sandboxChunk;
    const received = (assembly?.received ?? 0) + bytes.byteLength;
    const total = Math.min(
      requested.length,
      header.sizeBytes - requested.offset,
    );
    if (
      header.offset !== requested.offset + (assembly?.received ?? 0) ||
      received > total ||
      (bytes.byteLength === 0 && total !== 0) ||
      (assembly !== undefined &&
        (header.version !== assembly.version ||
          header.sizeBytes !== assembly.sizeBytes))
    ) {
      this.#settlePending(header.requestId, daemonFailureResponse("unknown"));
      return;
    }
    let body = bytes as Uint8Array<ArrayBuffer>;
    if (assembly !== undefined || received < total) {
      const next = assembly ?? {
        version: header.version,
        sizeBytes: header.sizeBytes,
        bytes: new Uint8Array(total),
        received: 0,
      };
      next.bytes.set(bytes, next.received);
      next.received = received;
      pending.sandboxChunk = next;
      if (received < total) return;
      body = next.bytes;
    }
    this.#settlePending(
      header.requestId,
      new Response(body, {
        headers: {
          "content-type": "application/octet-stream",
          [DXD_SANDBOX_CHUNK_HEADER]: JSON.stringify({
            version: header.version,
            sizeBytes: header.sizeBytes,
            offset: requested.offset,
          }),
        },
      }),
    );
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
        pending.sandboxChunk = undefined;
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

  /**
   * Activate the environment of a newly registered transport. Files save and
   * Terminal wait for it. The reconnect Changes repair is not part of it: the
   * daemon reports `changes-dirty` on every registration, and the resident
   * observer marks the projection dirty and answers with a `changes-refresh`
   * over this same channel, so a wake runs no guest command for Changes.
   */
  #startRepair(threadId: ThreadId) {
    const startedAt = Date.now();
    let repair: Promise<void>;
    repair = (
      this.#environmentActivation ?? this.#activateEnvironment(threadId)
    )
      .then(() => {
        threadDaemonLogger.info("Thread daemon repair timing.", {
          event: "thread_daemon_repair_timing",
          threadId,
          environmentMs: Date.now() - startedAt,
        });
      })
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
