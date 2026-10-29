import {
  IssueWorkloadIdentityRequestSchema,
  IssueWorkloadIdentityResultSchema,
  MAX_THREAD_STORAGE_FILE_BYTES,
  OrbFolderPathSchema,
  OrbFolderSchema,
  OrbProcessIdSchema,
  OrbProcessSchema,
  THREAD_FILES_MAX_EDITABLE_BYTES,
  THREAD_FILES_MAX_TREE_PAGE_SIZE,
  THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadFileVersion,
  ThreadSandboxFilePath,
  ThreadStorageFileIdSchema,
  type ThreadTerminalDimensions,
  ThreadTerminalDimensionsSchema,
} from "@dx/api";
import {
  EnvironmentVariableName,
  isReservedEnvironmentVariableName,
} from "@dx/domain";
import { Schema } from "effect";
import { decodeBase64Url, encodeBase64Url } from "../../encoding/base64.js";
import { utf8ExceedsBytes } from "../../encoding/utf8.js";
import {
  ThreadChangesCandidateContentSchema,
  ThreadChangesFingerprint,
} from "../../thread-changes/candidate.js";

export const DXD_PROTOCOL_MAJOR = 2;
export const DXD_RELEASE = "0.13.0";
export const DXD_TERMINAL_VERSION = 1;
export const DXD_WORKLOAD_IDENTITY_VERSION = 1;
export const DXD_HEARTBEAT_INTERVAL_MS = 2_000;
export const DXD_HEARTBEAT_LEASE_MS = 15_000;
export const DXD_CHANGES_QUIET_MS = 250;
export const DXD_MAX_CLIENT_FRAME_BYTES = 32 * 1_024 * 1_024;
export const DXD_MAX_CHANGES_CANDIDATE_BYTES = 8 * 1_024 * 1_024;
export const DXD_MAX_CONTROL_FRAME_BYTES = 4_096;
export const DXD_MAX_WORKLOAD_IDENTITY_FRAME_BYTES = 80 * 1_024;
export const DXD_MAX_REQUEST_FRAME_BYTES = 2 * 1_024 * 1_024;
export const DXD_MAX_ENVIRONMENT_REQUEST_FRAME_BYTES = 14 * 1_024 * 1_024;
export const DXD_MAX_RESPONSE_FRAME_BYTES = 4 * 1_024 * 1_024;
export const DXD_ENVIRONMENT_MAX_ENTRIES = 300;
export const DXD_ENVIRONMENT_MAX_VALUE_BYTES = 32_768;
export const DXD_ENVIRONMENT_MAX_TOTAL_VALUE_BYTES = 9_830_400;
export const DXD_TERMINAL_FRAME_HEADER_BYTES = 50;
export const DXD_TERMINAL_MAX_FRAME_BYTES = 65_536;
export const DXD_TERMINAL_MAX_PAYLOAD_BYTES = 65_486;
export const DXD_TERMINAL_SEND_BUFFER_BYTES = 2 * 1_024 * 1_024;

export const DaemonGeneration = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type DaemonGeneration = typeof DaemonGeneration.Type;

// Callers re-encode and compare, so the lenient native decoder is exact.
const generationToBytes = (value: string): Uint8Array => decodeBase64Url(value);

const canonicalNonZeroGeneration = (value: string) => {
  try {
    const bytes = generationToBytes(value);
    return (
      bytes.byteLength === 16 &&
      encodeBase64Url(bytes) === value &&
      bytes.some((byte) => byte !== 0)
    );
  } catch {
    return false;
  }
};

export const TerminalGeneration = Schema.String.check(
  Schema.isMinLength(22),
  Schema.isMaxLength(22),
  Schema.isPattern(/^[A-Za-z0-9_-]{22}$/),
  Schema.makeFilter(canonicalNonZeroGeneration),
).pipe(Schema.brand("@dx/TerminalGeneration"));
export type TerminalGeneration = typeof TerminalGeneration.Type;

const MAX_U64 = 18_446_744_073_709_551_615n;
export const DxdU64 = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/),
  Schema.makeFilter((value) => BigInt(value) <= MAX_U64),
).pipe(Schema.brand("@dx/DxdU64"));
export type DxdU64 = typeof DxdU64.Type;

export const DxdTerminalCapability = Schema.Struct({
  terminal: Schema.Struct({ version: Schema.Literal(DXD_TERMINAL_VERSION) }),
  workloadIdentity: Schema.Struct({
    version: Schema.Literal(DXD_WORKLOAD_IDENTITY_VERSION),
  }),
  /**
   * Version 1: dxd sends a sandbox chunk as several `DXF1` frames and keeps
   * only a few unacknowledged, so Core answers each frame with `chunk-ack`.
   */
  files: Schema.optional(Schema.Struct({ version: Schema.Literal(1) })),
  /**
   * Version 1: Core may open `proxy.open` streams to guest loopback ports
   * and send the `proxy.ports` and `desktop.ensure` operations.
   */
  proxy: Schema.optional(Schema.Struct({ version: Schema.Literal(1) })),
  /**
   * Version 1: heartbeats carry `memory`, and Core may send the
   * `memory.snapshot` and `memory.stop` operations.
   */
  memory: Schema.optional(Schema.Struct({ version: Schema.Literal(1) })),
  /**
   * Version 1: heartbeats carry `disk`, and Core may send the
   * `disk.snapshot` and `disk.delete` operations.
   */
  disk: Schema.optional(Schema.Struct({ version: Schema.Literal(1) })),
  /**
   * Version 1: Core may send the `storage.export` and `storage.import`
   * operations, which move files between the guest and Thread storage.
   */
  storage: Schema.optional(Schema.Struct({ version: Schema.Literal(1) })),
});

export const DxdTerminalHeartbeat = Schema.Union([
  Schema.Struct({
    terminalVersion: Schema.Literal(DXD_TERMINAL_VERSION),
    terminal: Schema.Literal("default"),
    state: Schema.Literal("absent"),
  }),
  Schema.Struct({
    terminalVersion: Schema.Literal(DXD_TERMINAL_VERSION),
    terminal: Schema.Literal("default"),
    state: Schema.Literals(["starting", "ready", "exited", "failed"]),
    residentGeneration: TerminalGeneration,
    foregroundCommand: Schema.Boolean,
    restartRequired: Schema.Boolean,
  }),
]);
export type DxdTerminalHeartbeat = typeof DxdTerminalHeartbeat.Type;

export const DxdChangesRefreshToken = Schema.String.check(
  Schema.isMinLength(16),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type DxdChangesRefreshToken = typeof DxdChangesRefreshToken.Type;

export const DxdChangesRefreshMessage = Schema.Struct({
  type: Schema.Literal("changes-refresh"),
  token: DxdChangesRefreshToken,
  source: Schema.Struct({
    baseline: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    defaultBranch: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(256),
    ),
  }),
  expectedFingerprint: Schema.optional(ThreadChangesFingerprint),
});
export type DxdChangesRefresh = typeof DxdChangesRefreshMessage.Type;

export const DxdChangesCandidateOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("unchanged"),
    fingerprint: ThreadChangesFingerprint,
  }),
  Schema.Struct({
    kind: Schema.Literal("complete"),
    capture: ThreadChangesCandidateContentSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("raced") }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "source-unavailable",
      "capture-failed",
      "timeout",
      "candidate-too-large",
    ]),
  }),
]);
export type DxdChangesCandidate = typeof DxdChangesCandidateOutcome.Type;

export const DxdChangesCandidateMessage = Schema.Struct({
  type: Schema.Literal("changes-candidate"),
  token: DxdChangesRefreshToken,
  outcome: DxdChangesCandidateOutcome,
});
export type DxdChangesCandidateEvent = typeof DxdChangesCandidateMessage.Type;

export const DxdChangesDirtyMessage = Schema.Struct({
  type: Schema.Literal("changes-dirty"),
});

/**
 * The first release whose `environment.activate` accepts every name Core's
 * `isReservedEnvironmentVariableName` allows, and empty values. Core sends an
 * earlier daemon only what it accepts. Gated on the reported release rather
 * than a new `register` key, so a Core rollback still admits newer daemons.
 */
export const DXD_CURRENT_ENVIRONMENT_RELEASE = "0.11.0";

const releaseParts = (release: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(release);
  return match === null ? undefined : match.slice(1).map(Number);
};

/** Whether a daemon on `release` accepts Core's current environment rule. */
export const dxdAcceptsCurrentEnvironment = (release: string | undefined) => {
  const parts = release === undefined ? undefined : releaseParts(release);
  const minimum = releaseParts(DXD_CURRENT_ENVIRONMENT_RELEASE) ?? [];
  if (parts === undefined) return false;
  for (const [index, part] of parts.entries()) {
    const floor = minimum[index] ?? 0;
    if (part !== floor) return part > floor;
  }
  return true;
};

/** A release the daemon reports; Core compares it with `DXD_RELEASE`. */
export const DxdReleaseVersion = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[A-Za-z0-9.-]+$/),
);
export type DxdReleaseVersion = typeof DxdReleaseVersion.Type;

/**
 * Registration carries no generation: the Durable Object assigns one in
 * `registered`. A daemon on an older release is accepted when its protocol
 * matches and is then told to update itself.
 */
export const DxdRegisterMessage = Schema.Struct({
  type: Schema.Literal("register"),
  protocolMajor: Schema.Literal(DXD_PROTOCOL_MAJOR),
  release: DxdReleaseVersion,
  capabilities: DxdTerminalCapability,
});

export const DxdUpdateStatusMessage = Schema.Struct({
  type: Schema.Literal("update-status"),
  generation: DaemonGeneration,
  release: DxdReleaseVersion,
  status: Schema.Literals(["applying", "failed"]),
});

export const DxdUpdateMessage = Schema.Struct({
  type: Schema.Literal("update"),
  generation: DaemonGeneration,
  url: Schema.String.check(
    Schema.isMinLength(9),
    Schema.isMaxLength(2_048),
    Schema.isPattern(/^https:\/\//),
  ),
  sha256: Schema.String.check(
    Schema.isMinLength(64),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[0-9a-f]{64}$/),
  ),
  release: DxdReleaseVersion,
});
export type DxdUpdateMessage = typeof DxdUpdateMessage.Type;

const DxdBytes = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** The guest's memory in use, measured by dxd on every provider. */
export const DxdMemoryUsage = Schema.Struct({
  usedBytes: DxdBytes,
  totalBytes: DxdBytes,
});
export type DxdMemoryUsage = typeof DxdMemoryUsage.Type;

/**
 * The workspace filesystem, measured by dxd on every provider. In use is
 * what the workspace user can no longer write.
 */
export const DxdDiskUsage = Schema.Struct({
  usedBytes: DxdBytes,
  totalBytes: DxdBytes,
});
export type DxdDiskUsage = typeof DxdDiskUsage.Type;

export const DxdHeartbeatMessage = Schema.Struct({
  type: Schema.Literal("heartbeat"),
  generation: DaemonGeneration,
  terminal: DxdTerminalHeartbeat,
  memory: Schema.optional(DxdMemoryUsage),
  disk: Schema.optional(DxdDiskUsage),
});

const TerminalControlBase = {
  terminalVersion: Schema.Literal(DXD_TERMINAL_VERSION),
  terminal: Schema.Literal("default"),
} as const;

export const DxdCoreTerminalControl = Schema.Union([
  Schema.Struct({
    ...TerminalControlBase,
    type: Schema.Literal("terminal.open"),
    mode: Schema.Literal("open-if-absent"),
    dimensions: ThreadTerminalDimensionsSchema,
  }),
  Schema.Struct({
    ...TerminalControlBase,
    type: Schema.Literal("terminal.open"),
    mode: Schema.Literal("restart-exited"),
    expectedResidentGeneration: TerminalGeneration,
    dimensions: ThreadTerminalDimensionsSchema,
  }),
  Schema.Struct({
    ...TerminalControlBase,
    type: Schema.Literal("terminal.restart"),
    expectedResidentGeneration: TerminalGeneration,
    dimensions: ThreadTerminalDimensionsSchema,
  }),
  Schema.Struct({
    ...TerminalControlBase,
    type: Schema.Literal("terminal.reset-attachments"),
    residentGeneration: TerminalGeneration,
  }),
  Schema.Struct({
    ...TerminalControlBase,
    type: Schema.Literal("terminal.attach"),
    residentGeneration: TerminalGeneration,
    attachmentGeneration: TerminalGeneration,
    resizeOrdinal: DxdU64,
    dimensions: ThreadTerminalDimensionsSchema,
  }),
  Schema.Struct({
    ...TerminalControlBase,
    type: Schema.Literal("terminal.resize"),
    residentGeneration: TerminalGeneration,
    attachmentGeneration: TerminalGeneration,
    resizeOrdinal: DxdU64,
    dimensions: ThreadTerminalDimensionsSchema,
  }),
  Schema.Struct({
    ...TerminalControlBase,
    type: Schema.Literal("terminal.detach"),
    residentGeneration: TerminalGeneration,
    attachmentGeneration: TerminalGeneration,
    reason: Schema.Literals([
      "browser-detached",
      "slow-consumer",
      "rebind",
      "lifecycle",
    ]),
  }),
]);
export type DxdCoreTerminalControl = typeof DxdCoreTerminalControl.Type;

const DxdResidentState = Schema.Struct({
  ...TerminalControlBase,
  type: Schema.Literal("terminal.resident-state"),
  residentGeneration: TerminalGeneration,
  state: Schema.Literals(["starting", "ready", "exited", "failed"]),
  dimensions: ThreadTerminalDimensionsSchema,
  nextOutputSequence: DxdU64,
  foregroundCommand: Schema.Boolean,
  restartRequired: Schema.Boolean,
});

const DxdReplayStart = Schema.Struct({
  terminalVersion: Schema.Literal(DXD_TERMINAL_VERSION),
  type: Schema.Literal("terminal.replay-start"),
  residentGeneration: TerminalGeneration,
  attachmentGeneration: TerminalGeneration,
  firstOutputSequence: DxdU64,
  throughOutputSequence: DxdU64,
  replayBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: DXD_TERMINAL_MAX_FRAME_BYTES }),
  ),
  truncated: Schema.Boolean,
});

const DxdAttachmentReady = Schema.Struct({
  terminalVersion: Schema.Literal(DXD_TERMINAL_VERSION),
  type: Schema.Literal("terminal.attachment-ready"),
  residentGeneration: TerminalGeneration,
  attachmentGeneration: TerminalGeneration,
  throughOutputSequence: DxdU64,
  dimensionsRevision: DxdU64,
  dimensions: ThreadTerminalDimensionsSchema,
});

const DxdDimensions = Schema.Struct({
  terminalVersion: Schema.Literal(DXD_TERMINAL_VERSION),
  type: Schema.Literal("terminal.dimensions"),
  residentGeneration: TerminalGeneration,
  resizeOrdinal: DxdU64,
  dimensionsRevision: DxdU64,
  dimensions: ThreadTerminalDimensionsSchema,
});

const DxdDetached = Schema.Struct({
  terminalVersion: Schema.Literal(DXD_TERMINAL_VERSION),
  type: Schema.Literal("terminal.detached"),
  residentGeneration: TerminalGeneration,
  attachmentGeneration: TerminalGeneration,
});

const DxdTerminalError = Schema.Struct({
  terminalVersion: Schema.Literal(DXD_TERMINAL_VERSION),
  type: Schema.Literal("terminal.error"),
  residentGeneration: TerminalGeneration,
  attachmentGeneration: Schema.optional(TerminalGeneration),
  code: Schema.Literals([
    "invalid-attachment",
    "attachment-limit",
    "input-overflow",
    "terminal-exited",
    "terminal-overflow",
    "terminal-unavailable",
  ]),
});

export const DxdClientTerminalControl = Schema.Union([
  DxdResidentState,
  DxdReplayStart,
  DxdAttachmentReady,
  DxdDimensions,
  DxdDetached,
  DxdTerminalError,
]);
export type DxdClientTerminalControl =
  | {
      readonly terminalVersion: 1;
      readonly type: "terminal.resident-state";
      readonly terminal: "default";
      readonly residentGeneration: TerminalGeneration;
      readonly state: "starting" | "ready" | "exited" | "failed";
      readonly dimensions: ThreadTerminalDimensions;
      readonly nextOutputSequence: DxdU64;
      readonly foregroundCommand: boolean;
      readonly restartRequired: boolean;
    }
  | {
      readonly terminalVersion: 1;
      readonly type: "terminal.replay-start";
      readonly residentGeneration: TerminalGeneration;
      readonly attachmentGeneration: TerminalGeneration;
      readonly firstOutputSequence: DxdU64;
      readonly throughOutputSequence: DxdU64;
      readonly replayBytes: number;
      readonly truncated: boolean;
    }
  | {
      readonly terminalVersion: 1;
      readonly type: "terminal.attachment-ready";
      readonly residentGeneration: TerminalGeneration;
      readonly attachmentGeneration: TerminalGeneration;
      readonly throughOutputSequence: DxdU64;
      readonly dimensionsRevision: DxdU64;
      readonly dimensions: ThreadTerminalDimensions;
    }
  | {
      readonly terminalVersion: 1;
      readonly type: "terminal.dimensions";
      readonly residentGeneration: TerminalGeneration;
      readonly resizeOrdinal: DxdU64;
      readonly dimensionsRevision: DxdU64;
      readonly dimensions: ThreadTerminalDimensions;
    }
  | {
      readonly terminalVersion: 1;
      readonly type: "terminal.detached";
      readonly residentGeneration: TerminalGeneration;
      readonly attachmentGeneration: TerminalGeneration;
    }
  | {
      readonly terminalVersion: 1;
      readonly type: "terminal.error";
      readonly residentGeneration: TerminalGeneration;
      readonly attachmentGeneration?: TerminalGeneration;
      readonly code:
        | "invalid-attachment"
        | "attachment-limit"
        | "input-overflow"
        | "terminal-exited"
        | "terminal-overflow"
        | "terminal-unavailable";
    };

export type DxdTerminalFrameKind = 1 | 2 | 3;
export interface DxdTerminalFrame {
  readonly kind: DxdTerminalFrameKind;
  readonly residentGeneration: TerminalGeneration;
  readonly attachmentGeneration?: TerminalGeneration;
  readonly sequence: DxdU64;
  readonly payload: Uint8Array;
}

export const encodeDxdTerminalFrame = (frame: DxdTerminalFrame): Uint8Array => {
  if (
    frame.payload.byteLength < 1 ||
    frame.payload.byteLength > DXD_TERMINAL_MAX_PAYLOAD_BYTES ||
    BigInt(frame.sequence) < 1n ||
    (frame.kind === 3) !== (frame.attachmentGeneration === undefined)
  )
    throw new Error("Invalid DXT1 frame.");
  const resident = generationToBytes(frame.residentGeneration);
  const attachment =
    frame.attachmentGeneration === undefined
      ? new Uint8Array(16)
      : generationToBytes(frame.attachmentGeneration);
  const encoded = new Uint8Array(
    DXD_TERMINAL_FRAME_HEADER_BYTES + frame.payload.byteLength,
  );
  encoded.set([0x44, 0x58, 0x54, 0x31], 0);
  encoded[4] = frame.kind;
  encoded[5] = 0;
  encoded.set(resident, 6);
  encoded.set(attachment, 22);
  const view = new DataView(encoded.buffer);
  view.setBigUint64(38, BigInt(frame.sequence));
  view.setUint32(46, frame.payload.byteLength);
  encoded.set(frame.payload, DXD_TERMINAL_FRAME_HEADER_BYTES);
  return encoded;
};

export const decodeDxdTerminalFrame = (
  source: ArrayBuffer | ArrayBufferView,
): DxdTerminalFrame => {
  const bytes =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (
    bytes.byteLength <= DXD_TERMINAL_FRAME_HEADER_BYTES ||
    bytes.byteLength > DXD_TERMINAL_MAX_FRAME_BYTES ||
    bytes[0] !== 0x44 ||
    bytes[1] !== 0x58 ||
    bytes[2] !== 0x54 ||
    bytes[3] !== 0x31 ||
    (bytes[4] !== 1 && bytes[4] !== 2 && bytes[4] !== 3) ||
    bytes[5] !== 0
  )
    throw new Error("Invalid DXT1 frame.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(46) !== bytes.byteLength - DXD_TERMINAL_FRAME_HEADER_BYTES)
    throw new Error("Invalid DXT1 frame.");
  const residentGeneration = Schema.decodeUnknownSync(TerminalGeneration)(
    encodeBase64Url(bytes.subarray(6, 22)),
  );
  const attachmentBytes = bytes.subarray(22, 38);
  const zeroAttachment = attachmentBytes.every((byte) => byte === 0);
  if ((bytes[4] === 3) !== zeroAttachment)
    throw new Error("Invalid DXT1 frame.");
  const attachmentGeneration = zeroAttachment
    ? undefined
    : Schema.decodeUnknownSync(TerminalGeneration)(
        encodeBase64Url(attachmentBytes),
      );
  const sequence = Schema.decodeUnknownSync(DxdU64)(
    view.getBigUint64(38).toString(),
  );
  if (BigInt(sequence) < 1n) throw new Error("Invalid DXT1 frame.");
  return {
    kind: bytes[4] as DxdTerminalFrameKind,
    residentGeneration,
    ...(attachmentGeneration === undefined ? {} : { attachmentGeneration }),
    sequence,
    payload: bytes.slice(DXD_TERMINAL_FRAME_HEADER_BYTES),
  };
};

export const DxdRequestId = Schema.String.check(
  Schema.isMinLength(16),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export type DxdRequestId = typeof DxdRequestId.Type;

const DxdListCursor = Schema.Struct({
  version: ThreadFileVersion,
  index: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
});

export const DxdFilesListOperation = Schema.Struct({
  operation: Schema.Literal("files.list"),
  worktree: Schema.optional(ThreadFilesWorktreeId),
  path: Schema.NullOr(ThreadFilesPath),
  cursor: Schema.optional(DxdListCursor),
});
export type DxdFilesListOperation = typeof DxdFilesListOperation.Type;

export const DxdFilesReadOperation = Schema.Struct({
  operation: Schema.Literal("files.read"),
  worktree: Schema.optional(ThreadFilesWorktreeId),
  path: ThreadFilesPath,
});
export type DxdFilesReadOperation = typeof DxdFilesReadOperation.Type;

export const DxdFilesSaveOperation = Schema.Struct({
  operation: Schema.Literal("files.save"),
  worktree: Schema.optional(ThreadFilesWorktreeId),
  path: ThreadFilesPath,
  expectedVersion: ThreadFileVersion,
  content: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        !value.includes("\0") &&
        !utf8ExceedsBytes(value, THREAD_FILES_MAX_EDITABLE_BYTES),
    ),
  ),
  refresh: Schema.optional(DxdChangesRefreshMessage),
});
export type DxdFilesSaveOperation = typeof DxdFilesSaveOperation.Type;

/** Read-only byte range of any regular file in the guest. */
export const DxdFilesReadSandboxOperation = Schema.Struct({
  operation: Schema.Literal("files.readSandbox"),
  path: ThreadSandboxFilePath,
  offset: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  length: Schema.Int.check(
    Schema.isBetween({
      minimum: 1,
      maximum: THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES,
    }),
  ),
  expectedVersion: Schema.optional(ThreadFileVersion),
});
export type DxdFilesReadSandboxOperation =
  typeof DxdFilesReadSandboxOperation.Type;

export const DxdFilesOperation = Schema.Union([
  DxdFilesListOperation,
  DxdFilesReadOperation,
  DxdFilesSaveOperation,
  DxdFilesReadSandboxOperation,
]);
export type DxdFilesOperation = typeof DxdFilesOperation.Type;

const canonicalEnvironmentValue = (value: string) => {
  try {
    // Native decode; the re-encode comparison below rejects non-canonical input.
    const bytes = decodeBase64Url(value);
    const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.byteLength <= DXD_ENVIRONMENT_MAX_VALUE_BYTES &&
      !plaintext.includes("\0") &&
      encodeBase64Url(bytes) === value
      ? bytes.byteLength
      : undefined;
  } catch {
    return undefined;
  }
};

/** An empty string is an empty env var value (`DXD_CURRENT_ENVIRONMENT_RELEASE`). */
const CanonicalBase64Url = Schema.String.check(
  Schema.isMaxLength(43_691),
  Schema.isPattern(/^[A-Za-z0-9_-]*$/),
  Schema.makeFilter((value) => canonicalEnvironmentValue(value) !== undefined),
);

export const DxdEnvironmentEntry = Schema.Struct({
  name: EnvironmentVariableName.check(
    Schema.makeFilter((name) => !isReservedEnvironmentVariableName(name)),
  ),
  valueBase64Url: CanonicalBase64Url,
});
export type DxdEnvironmentEntry = typeof DxdEnvironmentEntry.Type;

const DxdGitConfigValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^\r\n\0]+$/),
);

const DxdThreadUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(
    /^(?:https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?)\/threads\/thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
);

export const DxdEnvironmentActivateOperation = Schema.Struct({
  operation: Schema.Literal("environment.activate"),
  generation: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  entries: Schema.Array(DxdEnvironmentEntry).check(
    Schema.isMaxLength(DXD_ENVIRONMENT_MAX_ENTRIES),
  ),
  git: Schema.Struct({
    authorName: DxdGitConfigValue,
    authorEmail: DxdGitConfigValue,
    threadUrl: DxdThreadUrl,
    signingEnabled: Schema.Boolean,
    bitbucketGateway: Schema.optional(
      Schema.Struct({
        origin: Schema.String.check(
          Schema.isMinLength(9),
          Schema.isMaxLength(255),
          Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/),
        ),
      }),
    ),
  }),
}).check(
  Schema.makeFilter((operation) => {
    let previous: string | undefined;
    let total = 0;
    for (const entry of operation.entries) {
      if (previous !== undefined && previous >= entry.name) return false;
      const bytes = canonicalEnvironmentValue(entry.valueBase64Url);
      if (bytes === undefined) return false;
      total += bytes;
      if (total > DXD_ENVIRONMENT_MAX_TOTAL_VALUE_BYTES) return false;
      previous = entry.name;
    }
    return true;
  }),
);
export type DxdEnvironmentActivateOperation =
  typeof DxdEnvironmentActivateOperation.Type;

/**
 * Digest-first activation: Core asks whether the daemon already applied this
 * exact environment (entries and Git configuration) before sending it.
 */
export const DxdEnvironmentCheckOperation = Schema.Struct({
  operation: Schema.Literal("environment.check"),
  generation: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  digest: Schema.String.check(
    Schema.isMinLength(64),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[0-9a-f]{64}$/),
  ),
});
export type DxdEnvironmentCheckOperation =
  typeof DxdEnvironmentCheckOperation.Type;

/** Must match `activation_digest` in `apps/dxd/src/environment.rs`. */
export const environmentActivationDigest = async (
  operation: Omit<DxdEnvironmentActivateOperation, "operation" | "generation">,
): Promise<string> => {
  let text = "dxd-environment-digest-v1\n";
  for (const entry of operation.entries)
    text += `${entry.name}=${entry.valueBase64Url}\n`;
  text += `git.authorName=${operation.git.authorName}\n`;
  text += `git.authorEmail=${operation.git.authorEmail}\n`;
  text += `git.threadUrl=${operation.git.threadUrl}\n`;
  text += `git.signingEnabled=${operation.git.signingEnabled ? "true" : "false"}\n`;
  text += "git.bitbucketGateway=";
  if (operation.git.bitbucketGateway !== undefined)
    text += operation.git.bitbucketGateway.origin;
  text += "\n";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
};

export const DxdEnvironmentActivateResult = Schema.Struct({
  kind: Schema.Literals([
    "applied",
    "unchanged",
    "superseded",
    "unavailable",
    "missing",
    "resume-timeout",
  ]),
  generation: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  shell: Schema.Literals(["no-shell", "current", "restart-required"]),
});
export type DxdEnvironmentActivateResult =
  typeof DxdEnvironmentActivateResult.Type;

/** The guest's TCP listeners owned by the workspace user. */
export const DxdProxyPortsOperation = Schema.Struct({
  operation: Schema.Literal("proxy.ports"),
});

/** Start the image's desktop, or confirm it runs. */
export const DxdDesktopEnsureOperation = Schema.Struct({
  operation: Schema.Literal("desktop.ensure"),
});

/** Start declared services that are not serving; see `thread-services`. */
export const DxdServicesEnsureOperation = Schema.Struct({
  operation: Schema.Literal("services.ensure"),
  services: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      command: Schema.String,
      cwd: Schema.optional(Schema.String),
      port: Schema.Int,
      env: Schema.Record(Schema.String, Schema.String),
    }),
  ),
});

/** The guest's memory and its largest processes; see `orb-memory`. */
export const DxdMemorySnapshotOperation = Schema.Struct({
  operation: Schema.Literal("memory.snapshot"),
});

/** Stop one listed process: `SIGTERM`, then `SIGKILL` after five seconds. */
export const DxdMemoryStopOperation = Schema.Struct({
  operation: Schema.Literal("memory.stop"),
  process: OrbProcessIdSchema,
});

/** The largest folders in the checkout and home; see `orb-disk`. */
export const DxdDiskSnapshotOperation = Schema.Struct({
  operation: Schema.Literal("disk.snapshot"),
});

/** Delete one listed rebuildable folder, relative to the home. */
export const DxdDiskDeleteOperation = Schema.Struct({
  operation: Schema.Literal("disk.delete"),
  path: OrbFolderPathSchema,
});

/** The most files one `storage.export` or `storage.import` moves. */
export const DXD_STORAGE_TRANSFER_MAX_FILES = 200;

/** A guest path: absolute, or relative to the workspace root. */
const DxdTransferPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => !value.includes("\0")),
);

/**
 * A file's permission bits (`mode & 0o777`), carried from the file a
 * transfer reads to the file it writes. Daemons built before it omit it.
 */
const DxdTransferMode = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 0o777 }),
);

/**
 * Store guest files in this Thread's storage as temporary files: dxd uploads
 * each straight to R2 through the same routes as `dxd files put`. An empty
 * file is reported, not stored; a file over `maxBytes` is skipped. dxd stops
 * starting files, and skips the rest as `timeout`, before Core stops waiting.
 */
export const DxdStorageExportOperation = Schema.Struct({
  operation: Schema.Literal("storage.export"),
  files: Schema.Array(Schema.Struct({ path: DxdTransferPath })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DXD_STORAGE_TRANSFER_MAX_FILES),
  ),
  maxBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_THREAD_STORAGE_FILE_BYTES }),
  ),
});
export type DxdStorageExportOperation = typeof DxdStorageExportOperation.Type;

/**
 * Write stored files into the guest: dxd downloads each straight from R2
 * through the same route as `dxd files get`, which reads as this Thread's
 * owner. `empty` creates an empty file. An existing file is kept unless
 * `overwrite`, without a window in which another writer's file is replaced;
 * a missing parent directory is created only with `createParents`. The file
 * gets `mode` when given, else an overwritten file's mode. A file not in
 * place before Core stops waiting is skipped as `timeout`, never written.
 */
export const DxdStorageImportOperation = Schema.Struct({
  operation: Schema.Literal("storage.import"),
  files: Schema.Array(
    Schema.Struct({
      path: DxdTransferPath,
      source: Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("stored"),
          id: ThreadStorageFileIdSchema,
          mode: Schema.optional(DxdTransferMode),
        }),
        Schema.Struct({
          kind: Schema.Literal("empty"),
          mode: Schema.optional(DxdTransferMode),
        }),
      ]),
    }),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DXD_STORAGE_TRANSFER_MAX_FILES),
  ),
  overwrite: Schema.Boolean,
  createParents: Schema.Boolean,
});
export type DxdStorageImportOperation = typeof DxdStorageImportOperation.Type;

export const DxdStorageOperation = Schema.Union([
  DxdStorageExportOperation,
  DxdStorageImportOperation,
]);
export type DxdStorageOperation = typeof DxdStorageOperation.Type;

export const DxdOperation = Schema.Union([
  DxdFilesOperation,
  DxdEnvironmentActivateOperation,
  DxdEnvironmentCheckOperation,
  DxdProxyPortsOperation,
  DxdDesktopEnsureOperation,
  DxdServicesEnsureOperation,
  DxdMemorySnapshotOperation,
  DxdMemoryStopOperation,
  DxdDiskSnapshotOperation,
  DxdDiskDeleteOperation,
  DxdStorageExportOperation,
  DxdStorageImportOperation,
]);
export type DxdOperation = typeof DxdOperation.Type;

const DxdTreeEntry = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  kind: Schema.Literals(["file", "directory", "symlink"]),
  sizeBytes: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  ),
});

const DxdFailureResult = Schema.Struct({
  kind: Schema.Literals(["invalid", "missing", "conflict", "unavailable"]),
});

const DxdTreeResult = Schema.Struct({
  kind: Schema.Literal("tree"),
  version: ThreadFileVersion,
  entries: Schema.Array(DxdTreeEntry).check(
    Schema.isMaxLength(THREAD_FILES_MAX_TREE_PAGE_SIZE),
  ),
  nextIndex: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  ),
});

const DxdEditableResult = Schema.Struct({
  kind: Schema.Literal("editable"),
  version: ThreadFileVersion,
  content: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        !value.includes("\0") &&
        !utf8ExceedsBytes(value, THREAD_FILES_MAX_EDITABLE_BYTES),
    ),
  ),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: THREAD_FILES_MAX_EDITABLE_BYTES }),
  ),
});

const DxdSavedResult = Schema.Struct({
  kind: Schema.Literal("saved"),
  version: ThreadFileVersion,
});

const DxdReadonlyResult = Schema.Struct({
  kind: Schema.Literal("readonly"),
  reason: Schema.Literals(["binary", "encoding", "too-large"]),
  content: Schema.Literal(""),
  sizeBytes: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});

export const DxdFilesListResult = Schema.Union([
  DxdTreeResult,
  DxdFailureResult,
]);
export type DxdFilesListResult = typeof DxdFilesListResult.Type;

export const DxdFilesReadResult = Schema.Union([
  DxdEditableResult,
  DxdReadonlyResult,
  DxdFailureResult,
]);
export type DxdFilesReadResult = typeof DxdFilesReadResult.Type;

export const DxdFilesSaveResult = Schema.Union([
  DxdSavedResult,
  DxdFailureResult,
]);
export type DxdFilesSaveResult = typeof DxdFilesSaveResult.Type;

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** JSON header of a binary `DXF1` sandbox chunk frame. */
export const DxdSandboxChunkHeader = Schema.Struct({
  generation: DaemonGeneration,
  requestId: DxdRequestId,
  version: ThreadFileVersion,
  sizeBytes: NonNegativeSafeInt,
  offset: NonNegativeSafeInt,
});
export type DxdSandboxChunkHeader = typeof DxdSandboxChunkHeader.Type;

/**
 * A successful sandbox read never crosses the socket as JSON: dxd sends its
 * raw bytes as one or more binary `DXF1` frames with consecutive offsets, and
 * the Durable Object joins them. Only failures arrive as JSON results.
 */
export type DxdFilesReadSandboxResult =
  | (Omit<DxdSandboxChunkHeader, "generation" | "requestId"> & {
      readonly kind: "sandbox-chunk";
      readonly bytes: Uint8Array;
    })
  | typeof DxdFailureResult.Type;

export const DxdFilesReadSandboxFailure = DxdFailureResult;

/** Internal header carrying chunk metadata from the Durable Object. */
export const DXD_SANDBOX_CHUNK_HEADER = "x-dx-sandbox-chunk";

/** `DXF1` magic that distinguishes sandbox chunks from `DXT1` terminal frames. */
export const DXD_SANDBOX_CHUNK_MAGIC = [0x44, 0x58, 0x46, 0x31] as const;
const DXD_SANDBOX_CHUNK_MAX_HEADER_BYTES = 4_096;
export const DXD_SANDBOX_CHUNK_MAX_FRAME_BYTES =
  8 + DXD_SANDBOX_CHUNK_MAX_HEADER_BYTES + THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES;

export const isDxdSandboxChunkFrame = (bytes: Uint8Array) =>
  bytes.byteLength >= 8 &&
  DXD_SANDBOX_CHUNK_MAGIC.every((byte, index) => bytes[index] === byte);

/**
 * Decode `DXF1 | u32 BE header length | JSON header | raw bytes`. The payload
 * is a view into the frame, so the bytes are never copied or re-encoded.
 */
export const decodeDxdSandboxChunkFrame = (
  source: ArrayBuffer | ArrayBufferView,
): { readonly header: DxdSandboxChunkHeader; readonly bytes: Uint8Array } => {
  const bytes =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (
    !isDxdSandboxChunkFrame(bytes) ||
    bytes.byteLength > DXD_SANDBOX_CHUNK_MAX_FRAME_BYTES
  )
    throw new Error("Invalid DXF1 frame.");
  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(4);
  if (
    headerLength < 2 ||
    headerLength > DXD_SANDBOX_CHUNK_MAX_HEADER_BYTES ||
    8 + headerLength > bytes.byteLength
  )
    throw new Error("Invalid DXF1 frame.");
  const header = Schema.decodeUnknownSync(DxdSandboxChunkHeader)(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(8, 8 + headerLength),
      ),
    ),
    { onExcessProperty: "error" },
  );
  const payload = bytes.subarray(8 + headerLength);
  if (
    payload.byteLength > THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES ||
    header.offset + payload.byteLength > header.sizeBytes
  )
    throw new Error("Invalid DXF1 frame.");
  return { header, bytes: payload };
};

export const DxdProxyPortsResult = Schema.Struct({
  kind: Schema.Literal("ports"),
  ports: Schema.Array(
    Schema.Struct({
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      address: Schema.String.check(Schema.isMaxLength(64)),
    }),
  ).check(Schema.isMaxLength(64)),
});
export type DxdProxyPortsResult = typeof DxdProxyPortsResult.Type;

export const DxdMemorySnapshotResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    usedBytes: DxdBytes,
    totalBytes: DxdBytes,
    processes: Schema.Array(OrbProcessSchema).check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literal("unreadable"),
  }),
]);
export type DxdMemorySnapshotResult = typeof DxdMemorySnapshotResult.Type;

export const DxdMemoryStopResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stop"),
    state: Schema.Literals(["stopping", "stopped"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["invalid", "not-found", "protected"]),
  }),
]);
export type DxdMemoryStopResult = typeof DxdMemoryStopResult.Type;

export const DxdDiskSnapshotResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    usedBytes: DxdBytes,
    totalBytes: DxdBytes,
    folders: Schema.Array(OrbFolderSchema).check(Schema.isMaxLength(16)),
    partial: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literal("unreadable"),
  }),
]);
export type DxdDiskSnapshotResult = typeof DxdDiskSnapshotResult.Type;

export const DxdDiskDeleteResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("deleted") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["invalid", "missing", "protected"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literal("failed"),
  }),
]);
export type DxdDiskDeleteResult = typeof DxdDiskDeleteResult.Type;

const DxdTransferMessage = Schema.String.check(Schema.isMaxLength(512));

/** One result per requested file, in request order. */
export const DxdStorageExportResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exported"),
    files: Schema.Array(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("stored"),
          id: ThreadStorageFileIdSchema,
          size: DxdBytes,
          mode: Schema.optional(DxdTransferMode),
        }),
        Schema.Struct({
          kind: Schema.Literal("empty"),
          mode: Schema.optional(DxdTransferMode),
        }),
        Schema.Struct({
          kind: Schema.Literal("skipped"),
          reason: Schema.Literals([
            "missing",
            "not-file",
            "too-large",
            "unreadable",
            "failed",
            "timeout",
          ]),
          message: Schema.optional(DxdTransferMessage),
        }),
      ]),
    ).check(Schema.isMaxLength(DXD_STORAGE_TRANSFER_MAX_FILES)),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["invalid", "failed"]),
  }),
]);
export type DxdStorageExportResult = typeof DxdStorageExportResult.Type;

/** One result per requested file, in request order. */
export const DxdStorageImportResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("imported"),
    files: Schema.Array(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("written"),
          path: Schema.String.check(Schema.isMaxLength(4_096)),
          size: DxdBytes,
        }),
        Schema.Struct({
          kind: Schema.Literal("skipped"),
          reason: Schema.Literals([
            "exists",
            "no-parent",
            "invalid",
            "failed",
            "timeout",
          ]),
          message: Schema.optional(DxdTransferMessage),
        }),
      ]),
    ).check(Schema.isMaxLength(DXD_STORAGE_TRANSFER_MAX_FILES)),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["invalid", "failed"]),
  }),
]);
export type DxdStorageImportResult = typeof DxdStorageImportResult.Type;

export const DxdDesktopEnsureResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["unsupported", "failed"]),
  }),
]);
export type DxdDesktopEnsureResult = typeof DxdDesktopEnsureResult.Type;

/** An invalid service is `failed`; too many services is `unavailable`. */
export const DxdServicesEnsureResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("services"),
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        state: Schema.Literals(["running", "starting", "started", "failed"]),
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literal("invalid"),
  }),
]);

/**
 * `DXP1` proxy frames: `DXP1 | u32 BE stream | u8 kind | 3 zero bytes |
 * payload`. Kind 0 is bytes (an HTTP body chunk or a binary WebSocket
 * message); kind 1 is a text WebSocket message.
 */
export const DXD_PROXY_FRAME_MAGIC = [0x44, 0x58, 0x50, 0x31] as const;
export const DXD_PROXY_FRAME_HEADER_BYTES = 12;
export const DXD_PROXY_KIND_BYTES = 0;
export const DXD_PROXY_KIND_TEXT = 1;
/** Unacknowledged data frames per stream in each direction. */
export const DXD_PROXY_STREAM_WINDOW = 16;
export const DXD_PROXY_MAX_BODY_CHUNK_BYTES = 256 * 1024;
export const DXD_PROXY_MAX_WEBSOCKET_MESSAGE_BYTES = 4 * 1024 * 1024;
export const DXD_PROXY_MAX_FRAME_BYTES =
  DXD_PROXY_FRAME_HEADER_BYTES + DXD_PROXY_MAX_WEBSOCKET_MESSAGE_BYTES;
/** Bound on a `proxy.response` or `proxy.open` message with its headers. */
export const DXD_PROXY_MAX_HEAD_FRAME_BYTES = 96 * 1024;
export const DXD_PROXY_MAX_STREAM_ID = 0xffff_ffff;
// Request and response head bounds, in UTF-8 bytes. dxd's `proxy.rs` carries
// the same values; Core refuses a request that breaks one before sending it,
// and dxd fails only that stream when one still does.
export const DXD_PROXY_MAX_METHOD_BYTES = 16;
export const DXD_PROXY_MAX_TARGET_BYTES = 8 * 1024;
export const DXD_PROXY_MAX_HEADERS = 128;
export const DXD_PROXY_MAX_HEADER_NAME_BYTES = 256;
export const DXD_PROXY_MAX_HEADER_VALUE_BYTES = 16 * 1024;
/** Every header's name and value plus 4 bytes for `: ` and CRLF. */
export const DXD_PROXY_MAX_HEADER_BYTES = 64 * 1024;
export const DXD_PROXY_MAX_PROTOCOLS = 16;

/** An RFC 9110 token: methods, header names, and subprotocols. */
const PROXY_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * HTAB, visible ASCII, space, and any non-ASCII character. A lone surrogate
 * has no UTF-8 form, so dxd could not decode it.
 */
const PROXY_HEADER_VALUE = /^[\t\x20-\x7e\u0080-\ud7ff\ue000-\u{10ffff}]*$/u;
const PROXY_TARGET = /^\/[\x21-\x7e]*$/;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * Why dxd would refuse this `proxy.open`, or `undefined` when it accepts it:
 * `invalid` for the method, target, or subprotocols, `headers` when the
 * headers break a bound. Mirrors `ProxyOpen::valid` in dxd's `proxy.rs`.
 */
export const dxdProxyOpenProblem = (open: {
  readonly mode: "http" | "websocket";
  readonly method: string;
  readonly target: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly protocols: readonly string[];
  readonly body: boolean;
}): "invalid" | "headers" | undefined => {
  if (
    !PROXY_TOKEN.test(open.method) ||
    open.method.length > DXD_PROXY_MAX_METHOD_BYTES ||
    (open.mode === "websocket" && (open.method !== "GET" || open.body)) ||
    !PROXY_TARGET.test(open.target) ||
    open.target.length > DXD_PROXY_MAX_TARGET_BYTES ||
    open.protocols.length > DXD_PROXY_MAX_PROTOCOLS ||
    !open.protocols.every(
      (protocol) =>
        PROXY_TOKEN.test(protocol) &&
        protocol.length <= DXD_PROXY_MAX_HEADER_NAME_BYTES,
    )
  )
    return "invalid";
  if (open.headers.length > DXD_PROXY_MAX_HEADERS) return "headers";
  let total = 0;
  for (const [name, value] of open.headers) {
    const valueBytes = utf8Bytes(value);
    if (
      !PROXY_TOKEN.test(name) ||
      name.length > DXD_PROXY_MAX_HEADER_NAME_BYTES ||
      valueBytes > DXD_PROXY_MAX_HEADER_VALUE_BYTES ||
      !PROXY_HEADER_VALUE.test(value)
    )
      return "headers";
    total += name.length + valueBytes + 4;
  }
  return total > DXD_PROXY_MAX_HEADER_BYTES ? "headers" : undefined;
};

export const isDxdProxyFrame = (bytes: Uint8Array) =>
  bytes.byteLength >= DXD_PROXY_FRAME_HEADER_BYTES &&
  DXD_PROXY_FRAME_MAGIC.every((byte, index) => bytes[index] === byte);

export const encodeDxdProxyFrame = (
  streamId: number,
  kind: typeof DXD_PROXY_KIND_BYTES | typeof DXD_PROXY_KIND_TEXT,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> => {
  const frame = new Uint8Array(
    DXD_PROXY_FRAME_HEADER_BYTES + payload.byteLength,
  );
  frame.set(DXD_PROXY_FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, streamId);
  frame[8] = kind;
  frame.set(payload, DXD_PROXY_FRAME_HEADER_BYTES);
  return frame;
};

/** The payload is a view into the frame; it is never copied. */
export const decodeDxdProxyFrame = (
  source: ArrayBuffer | ArrayBufferView,
): {
  readonly streamId: number;
  readonly kind: typeof DXD_PROXY_KIND_BYTES | typeof DXD_PROXY_KIND_TEXT;
  readonly payload: Uint8Array;
} => {
  const bytes =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (
    !isDxdProxyFrame(bytes) ||
    bytes.byteLength > DXD_PROXY_MAX_FRAME_BYTES ||
    bytes[9] !== 0 ||
    bytes[10] !== 0 ||
    bytes[11] !== 0
  )
    throw new Error("Invalid DXP1 frame.");
  const streamId = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(4);
  const kind = bytes[8];
  if (
    streamId === 0 ||
    (kind !== DXD_PROXY_KIND_BYTES && kind !== DXD_PROXY_KIND_TEXT)
  )
    throw new Error("Invalid DXP1 frame.");
  return {
    streamId,
    kind,
    payload: bytes.subarray(DXD_PROXY_FRAME_HEADER_BYTES),
  };
};

const DxdProxyStreamId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: DXD_PROXY_MAX_STREAM_ID }),
);

const DxdProxyHeaderList = Schema.Array(
  Schema.Tuple([
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    Schema.String.check(Schema.isMaxLength(16 * 1024)),
  ]),
).check(Schema.isMaxLength(128));

/** Stream messages dxd sends, in order with the stream's `DXP1` frames. */
export const DxdProxyClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("proxy.response"),
    streamId: DxdProxyStreamId,
    status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 999 })),
    headers: DxdProxyHeaderList,
  }),
  Schema.Struct({
    type: Schema.Literal("proxy.accepted"),
    streamId: DxdProxyStreamId,
    protocol: Schema.NullOr(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("proxy.end"),
    streamId: DxdProxyStreamId,
  }),
  Schema.Struct({
    type: Schema.Literal("proxy.closed"),
    streamId: DxdProxyStreamId,
    code: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 4999 })),
    reason: Schema.String.check(Schema.isMaxLength(123)),
  }),
  Schema.Struct({
    type: Schema.Literal("proxy.error"),
    streamId: DxdProxyStreamId,
    reason: Schema.Literals([
      "upstream-unreachable",
      "upstream-timeout",
      "upstream-reset",
      "upstream-rejected",
      "invalid-request",
      "invalid-response",
      "too-many-streams",
      "closed",
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("proxy.ack"),
    streamId: DxdProxyStreamId,
  }),
]);
export type DxdProxyClientMessage = typeof DxdProxyClientMessage.Type;

export const DxdFilesResult = Schema.Union([
  DxdTreeResult,
  DxdEditableResult,
  DxdReadonlyResult,
  DxdSavedResult,
  DxdFailureResult,
]);

export const DxdResponseEnvelope = Schema.Struct({
  type: Schema.Literal("response"),
  generation: DaemonGeneration,
  requestId: DxdRequestId,
  result: Schema.Unknown,
});

export const DxdResponseMessage = Schema.Struct({
  type: Schema.Literal("response"),
  generation: DaemonGeneration,
  requestId: DxdRequestId,
  result: DxdFilesResult,
});

export const DxdWorkloadIdentityRequestMessage = Schema.Struct({
  type: Schema.Literal("workload-identity.request"),
  generation: DaemonGeneration,
  requestId: DxdRequestId,
  request: Schema.Union([
    IssueWorkloadIdentityRequestSchema,
    Schema.Struct({
      kind: Schema.Literal("git-sign"),
      payloadBase64: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(65_536),
        Schema.isPattern(/^[A-Za-z0-9_-]+$/),
      ),
    }),
    Schema.Struct({
      kind: Schema.Literal("git-credential"),
      protocol: Schema.Literal("https"),
      host: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(255),
        Schema.isPattern(/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/),
      ),
      path: Schema.optional(
        Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(512),
          Schema.isPattern(/^[A-Za-z0-9._/-]+$/),
        ),
      ),
    }),
  ]),
});
export type DxdWorkloadIdentityRequest =
  typeof DxdWorkloadIdentityRequestMessage.Type;

export const DxdWorkloadIdentityResponseMessage = Schema.Struct({
  type: Schema.Literal("workload-identity.response"),
  generation: DaemonGeneration,
  requestId: DxdRequestId,
  result: Schema.Union([
    IssueWorkloadIdentityResultSchema,
    Schema.Struct({ kind: Schema.Literal("signed"), signature: Schema.String }),
    Schema.Struct({
      kind: Schema.Literal("credential"),
      username: Schema.String,
      password: Schema.String,
    }),
  ]),
});
export type DxdWorkloadIdentityResponse =
  typeof DxdWorkloadIdentityResponseMessage.Type;

export const DxdClientControlMessage = Schema.Union([
  DxdRegisterMessage,
  DxdHeartbeatMessage,
  DxdChangesDirtyMessage,
  DxdUpdateStatusMessage,
  Schema.Struct({
    type: Schema.Literal("readiness-pong"),
    generation: DaemonGeneration,
    requestId: DxdRequestId,
  }),
  DxdClientTerminalControl,
]);

export const DxdClientMessage = Schema.Union([
  DxdClientControlMessage,
  DxdChangesCandidateMessage,
  DxdResponseMessage,
  DxdWorkloadIdentityRequestMessage,
]);

export const DxdRegisteredMessage = Schema.Struct({
  type: Schema.Literal("registered"),
  generation: DaemonGeneration,
  heartbeatIntervalMs: Schema.Literal(DXD_HEARTBEAT_INTERVAL_MS),
  heartbeatLeaseMs: Schema.Literal(DXD_HEARTBEAT_LEASE_MS),
});

export const DxdHeartbeatAcknowledgedMessage = Schema.Struct({
  type: Schema.Literal("heartbeat-ack"),
  generation: DaemonGeneration,
});

/** Core received one `DXF1` frame from a daemon with `files` version 1. */
export const DxdChunkAcknowledgedMessage = Schema.Struct({
  type: Schema.Literal("chunk-ack"),
});

export const DxdRequestMessage = Schema.Struct({
  type: Schema.Literal("request"),
  generation: DaemonGeneration,
  requestId: DxdRequestId,
  operation: DxdOperation,
});

export const DxdServerMessage = Schema.Union([
  DxdRegisteredMessage,
  DxdHeartbeatAcknowledgedMessage,
  DxdChunkAcknowledgedMessage,
  Schema.Struct({
    type: Schema.Literal("readiness-ping"),
    generation: DaemonGeneration,
    requestId: DxdRequestId,
  }),
  DxdChangesRefreshMessage,
  DxdRequestMessage,
  DxdWorkloadIdentityResponseMessage,
  DxdUpdateMessage,
  DxdCoreTerminalControl,
]);

/**
 * The static daemon configuration installed in the guest once. It carries no
 * generation, release, or protocol: those are negotiated on `register`, so
 * Core never rewrites the file or restarts the daemon.
 */
export interface DxdRuntimeConfiguration {
  readonly version: 2;
  readonly endpoint: string;
  readonly threadId: string;
  readonly apiKey: string;
  readonly workspaceRoot: string;
}
