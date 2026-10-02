import {
  IssueWorkloadIdentityRequestSchema,
  IssueWorkloadIdentityResultSchema,
  THREAD_FILES_MAX_EDITABLE_BYTES,
  THREAD_FILES_MAX_TREE_PAGE_SIZE,
  THREAD_SANDBOX_FILE_MAX_CHUNK_BYTES,
  ThreadFilesPath,
  ThreadFilesWorktreeId,
  ThreadFileVersion,
  ThreadSandboxFilePath,
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
export const DXD_RELEASE = "0.8.0";
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

export const DxdHeartbeatMessage = Schema.Struct({
  type: Schema.Literal("heartbeat"),
  generation: DaemonGeneration,
  terminal: DxdTerminalHeartbeat,
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
    return bytes.byteLength >= 1 &&
      bytes.byteLength <= DXD_ENVIRONMENT_MAX_VALUE_BYTES &&
      !plaintext.includes("\0") &&
      encodeBase64Url(bytes) === value
      ? bytes.byteLength
      : undefined;
  } catch {
    return undefined;
  }
};

const CanonicalBase64Url = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(43_691),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
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

export const DxdOperation = Schema.Union([
  DxdFilesOperation,
  DxdEnvironmentActivateOperation,
  DxdEnvironmentCheckOperation,
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
