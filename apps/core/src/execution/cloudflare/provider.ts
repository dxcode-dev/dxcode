import { env } from "cloudflare:workers";
import {
  type CloudflareRunnerProfileConfiguration,
  ThreadId,
} from "@dx/domain";
import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { orbContainerLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import type {
  ExecutionContext,
  ExecutionProvider,
  ExecutionWorkspaceResidency,
} from "../../plugins/execution/provider.js";
import { markRunFailure } from "../../runtime/run-failure.js";
import { assertThreadLifecycleState } from "../activation.js";
import { DEFAULT_WORKSPACE_INACTIVITY_MS } from "../activity.js";
import {
  type OrbGuestClient,
  orbGuest,
  orbGuestSandbox,
} from "../guest/orb-guest-client.js";
import {
  type DaemonGuestHandle,
  guestResidentDaemon,
} from "../guest/resident-daemon.js";
import {
  type ExecutionWorkspaceRecord,
  type ExecutionWorkspaceRecords,
  executionWorkspaceRecords,
} from "../workspace-record.js";
import {
  accountOrbContainer,
  type OrbContainerRpc,
} from "./account-orb-client.js";
import {
  ORB_WORKSPACE_RESET_DETAIL,
  type OrbOpenResult,
} from "./orb-container.js";

/** Default limit for one agent command, as E2B's sandbox timeout. */
export const DEFAULT_CLOUDFLARE_COMMAND_TIMEOUT_MS = 300_000;
const MIN_INACTIVITY_MS = 60_000;
const MAX_INACTIVITY_MS = 3_600_000;
const STATE_RETRIES = 3;
/**
 * The longest Core waits for the container object to open a workspace: its
 * lock, a snapshot restore, and the 90 s readiness wait, with headroom. An
 * open that took 945 s in production now fails here, and Flue retries the
 * run on a fresh stub.
 */
export const CLOUDFLARE_OPEN_TIMEOUT_MS = 180_000;
/** While an open waits, report that it still waits this often. */
const OPEN_PROGRESS_MS = 30_000;
/** How long `status`, asked before a wake, may take. */
const STATUS_TIMEOUT_MS = 20_000;
/** Waits before retrying an idempotent call on a fresh stub. */
const RESET_RETRY_DELAYS_MS = [250, 1_000] as const;

/** What a Cloudflare open is waiting for, for the Thread's status line. */
export type CloudflareOpenPhase = "starting-machine" | "waiting-for-machine";

/**
 * Core's activation passes this beside the provider-neutral create options;
 * other providers ignore it.
 */
export interface CloudflareOpenPhaseReporter {
  readonly onPreparationPhase?: (phase: CloudflareOpenPhase) => void;
}

export class CloudflareWorkspaceUnavailable extends Schema.TaggedError<CloudflareWorkspaceUnavailable>()(
  "CloudflareWorkspaceUnavailable",
  { reason: Schema.String },
) {}

const unavailable = (reason: string) =>
  new CloudflareWorkspaceUnavailable({ reason });

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The container object reset or lost its storage under the call: the stub
 * is dead ("this Durable Object instance is no longer active"), and a fresh
 * one reaches the restarted object.
 */
const RESET_PATTERN =
  /durable object|internal error; reference =|object to be reset/i;

const isObjectReset = (cause: unknown) => RESET_PATTERN.test(messageOf(cause));

const platformFailure = (code: string, message: string) =>
  new Error(
    markRunFailure({ class: "platform", code, message, retryable: true }),
  );

/**
 * The container stopped before its first pause and lost its files; the
 * object refuses to run anything on the empty container that would replace
 * it. Flue re-attempts the whole submission for this code (`cloudflare.ts`),
 * so activation sets the workspace up again before the turn retries.
 */
const workspaceReset = (method: string) =>
  platformFailure(
    "WORKSPACE_RESET",
    `The workspace's container stopped before it was ever saved, so its files are gone (${method}); the run starts again in a new workspace.`,
  );

const objectReset = (method: string, cause: unknown) =>
  platformFailure(
    "WORKSPACE_OBJECT_RESET",
    `The workspace's container object was reset during ${method}: ${messageOf(cause).slice(0, 300)}`,
  );

const sleep = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

/** `promise`, or `onTimeout()` thrown once `durationMs` passes. */
const bounded = async <A>(
  promise: Promise<A>,
  durationMs: number,
  onTimeout: () => Error,
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), durationMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Calls that repeat safely: they read, or set state to the same value. */
const IDEMPOTENT = new Set<string>([
  "open",
  "status",
  "readFile",
  "stat",
  "readdir",
  "exists",
  "setIdleDeadline",
]);

const InactivityMs = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: MIN_INACTIVITY_MS, maximum: MAX_INACTIVITY_MS }),
);

const inactivityMs = (bindings: Bindings) =>
  Effect.runPromise(
    Config.Number("DX_WORKSPACE_INACTIVITY_MS")
      .pipe(Config.withDefault(DEFAULT_WORKSPACE_INACTIVITY_MS))
      .parse(ConfigProvider.fromUnknown(bindings))
      .pipe(
        Effect.flatMap(Schema.decodeEffect(InactivityMs)),
        Effect.mapError(() => unavailable("configuration")),
      ),
  );

const cloudflareProfile = (
  profile: ExecutionContext["profile"],
): CloudflareRunnerProfileConfiguration => {
  if (profile.adapter !== "cloudflare")
    throw unavailable("Cloudflare execution requires a Cloudflare profile.");
  return profile;
};

const CLOUDFLARE = "cloudflare";

const readRecord = async (
  records: ExecutionWorkspaceRecords,
  threadId: string,
): Promise<ExecutionWorkspaceRecord> => {
  const record = await records.read(threadId);
  if (record === null) throw unavailable("no workspace record");
  return record;
};

/**
 * Each Thread's workspace is the Orb container object named by its ID: in
 * the deployer's account through the `ORB_CONTAINER` binding, or in a
 * connected account through that account's Orb Worker. The sandbox ID the
 * D1 record pins names the object in its account.
 */
const orbContainer = (
  context: ExecutionContext,
  bindings: Bindings,
  threadId: string,
): { readonly stub: OrbContainerRpc; readonly sandboxId: string } => {
  if (context.account.scope === "deployment") {
    const namespace = bindings.ORB_CONTAINER;
    if (namespace === undefined) throw unavailable("no ORB_CONTAINER binding");
    const stub = namespace.get(namespace.idFromName(threadId));
    return {
      stub: stub as unknown as OrbContainerRpc,
      sandboxId: stub.id.toString(),
    };
  }
  const profile = cloudflareProfile(context.profile);
  const secret =
    context.credentials === undefined
      ? undefined
      : Redacted.value(context.credentials).workerSecret;
  if (profile.endpoint === undefined || secret === undefined)
    throw unavailable("no account Orb Worker");
  return {
    stub: accountOrbContainer({
      endpoint: profile.endpoint,
      secret,
      threadId,
    }),
    sandboxId: `${context.account.providerAccount}:${threadId}`,
  };
};

type OrbContainerStub = OrbContainerRpc;

/**
 * The Thread's container object through whichever stub still works. After
 * a reset, the old stub fails every call, so the next call gets a fresh one
 * from `connect`. An idempotent call is retried on it up to twice with a
 * short wait; any other call (`exec` above all) is never replayed, and
 * fails as a platform failure that Flue retries as a whole.
 */
const resilientOrb = (
  first: OrbContainerStub,
  connect: () => OrbContainerStub,
  threadId: string,
  sandboxId: string,
): OrbContainerStub => {
  let stub = first;
  const call =
    (method: keyof OrbContainerStub) =>
    async (...args: ReadonlyArray<unknown>): Promise<unknown> => {
      for (let attempt = 0; ; attempt += 1) {
        const used = stub;
        try {
          return await (
            used[method] as (
              ...values: ReadonlyArray<unknown>
            ) => Promise<unknown>
          )(...args);
        } catch (cause) {
          if (messageOf(cause).includes(ORB_WORKSPACE_RESET_DETAIL))
            throw workspaceReset(method);
          if (!isObjectReset(cause)) throw cause;
          if (stub === used) stub = connect();
          const delay = IDEMPOTENT.has(method)
            ? RESET_RETRY_DELAYS_MS[attempt]
            : undefined;
          orbContainerLogger.warn("Orb container object reset under a call.", {
            event: "orb_container_reset",
            threadId,
            sandboxId,
            method,
            attempt: attempt + 1,
            outcome: delay === undefined ? "failed" : "retrying",
            error: messageOf(cause).slice(0, 500),
          });
          if (delay === undefined) throw objectReset(method, cause);
          await sleep(delay);
        }
      }
    };
  const methods: ReadonlyArray<keyof OrbContainerStub> = [
    "open",
    "status",
    "setIdleDeadline",
    "exec",
    "readFile",
    "writeFile",
    "stat",
    "readdir",
    "exists",
    "mkdir",
    "rm",
    "pause",
    "destroy",
  ];
  return Object.fromEntries(
    methods.map((method) => [method, call(method)]),
  ) as unknown as OrbContainerStub;
};

/** The raw workspace Core's pipeline prepares, over the container object. */
type CloudflareWorkspaceHandle = DaemonGuestHandle;

const handleFor = (
  stub: OrbContainerStub,
  idleMs: number,
  processesStartedAt: number | undefined,
): CloudflareWorkspaceHandle => {
  const client = stub as unknown as OrbGuestClient;
  return {
    guest: orbGuest(client),
    sandbox: async (cwd) => orbGuestSandbox(client, cwd),
    setIdleDeadline: (durationMs) => stub.setIdleDeadline(durationMs),
    inactivityMs: idleMs,
    commandTimeoutMs: DEFAULT_CLOUDFLARE_COMMAND_TIMEOUT_MS,
    ...(processesStartedAt === undefined ? {} : { processesStartedAt }),
  };
};

/**
 * Creates (on the first activation) or reconnects to the Thread's
 * container. The D1 record pins the provider and sandbox identity; the
 * container object pins the instance type and holds the snapshot. A wake is
 * one D1 read and one or two calls to that object: no provider choice, no
 * listing.
 */
const openCloudflareWorkspace = async (
  context: ExecutionContext,
  threadId: string,
  options: {
    readonly existingOnly: boolean;
    readonly authorize: () => Promise<void>;
    readonly observeResidency?: (
      residency: ExecutionWorkspaceResidency,
    ) => void | Promise<void>;
  } & CloudflareOpenPhaseReporter,
): Promise<CloudflareWorkspaceHandle> => {
  const bindings = env as Bindings;
  const profile = cloudflareProfile(context.profile);
  const idleMs = await inactivityMs(bindings);
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const records = executionWorkspaceRecords(db, CLOUDFLARE);
  const id = Schema.decodeUnknownSync(ThreadId)(threadId);
  const container = orbContainer(context, bindings, id);
  const { sandboxId } = container;
  const stub = resilientOrb(
    container.stub,
    () => orbContainer(context, bindings, id).stub,
    id,
    sandboxId,
  );
  const ready = (result: OrbOpenResult) => {
    if (result.kind === "ready")
      return handleFor(stub, idleMs, result.processesStartedAt);
    throw unavailable(`container ${result.kind}`);
  };
  // Core's view of one open: with the object's own logs (same `sandboxId`)
  // and Cloudflare's instance list (named by Thread), it places a slow start.
  // Only activation sets a workspace up, so only it may start one that lost
  // its files over from the image.
  const open = async (create: boolean) => {
    const startedAt = Date.now();
    const details = {
      event: "orb_container_open",
      threadId: id,
      sandboxId,
      create,
      instance: profile.instance,
    };
    // The Thread's status line says what the activation waits for.
    const report = (phase: CloudflareOpenPhase) => {
      try {
        options.onPreparationPhase?.(phase);
      } catch {
        // Reporting never fails the open.
      }
    };
    report("starting-machine");
    const progress = setInterval(() => {
      report("waiting-for-machine");
      orbContainerLogger.warn("Orb container open is still waiting.", {
        ...details,
        outcome: "waiting",
        elapsedMs: Date.now() - startedAt,
      });
    }, OPEN_PROGRESS_MS);
    try {
      const result = await bounded(
        stub.open({
          create,
          instance: profile.instance,
          idleMs,
          allowReset: !options.existingOnly,
        }),
        CLOUDFLARE_OPEN_TIMEOUT_MS,
        () =>
          platformFailure(
            "WORKSPACE_OPEN_TIMED_OUT",
            `The workspace open timed out after ${CLOUDFLARE_OPEN_TIMEOUT_MS / 1000} s.`,
          ),
      );
      orbContainerLogger.info("Orb container open returned.", {
        ...details,
        outcome: result.kind,
        ...(result.kind === "ready" ? { residency: result.residency } : {}),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (cause) {
      orbContainerLogger.error("Orb container open failed.", {
        ...details,
        outcome: "error",
        durationMs: Date.now() - startedAt,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    } finally {
      clearInterval(progress);
    }
  };
  for (let attempt = 0; attempt < STATE_RETRIES; attempt += 1) {
    const record = await readRecord(records, id);
    if (record.state === "uninitialized") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      await records.claim(id);
      continue;
    }
    // Pinned to another provider: never reached through this one.
    if (record.provider !== CLOUDFLARE) throw unavailable("other provider");
    if (record.state === "provisioning") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      const result = await open(true);
      const handle = ready(result);
      if (!(await records.initialize(id, record, sandboxId))) continue;
      return handle;
    }
    if (
      record.state !== "initialized" ||
      record.providerSandboxId !== sandboxId
    )
      throw unavailable(record.state);
    if (options.observeResidency !== undefined) {
      const status = await bounded(stub.status(), STATUS_TIMEOUT_MS, () =>
        platformFailure(
          "WORKSPACE_STATUS_TIMED_OUT",
          `The workspace status did not answer within ${STATUS_TIMEOUT_MS / 1000} s.`,
        ),
      );
      await options.observeResidency(status.running ? "running" : "paused");
    }
    await options.authorize();
    const result = await open(false);
    if (result.kind !== "ready") {
      await records.markLost(id);
      throw unavailable(`container ${result.kind}`);
    }
    return handleFor(stub, idleMs, result.processesStartedAt);
  }
  throw unavailable("contended");
};

/**
 * The second Execution provider: Cloudflare Containers, one container per
 * Thread owned by a Durable Object in the deployer's account or in a
 * person's or workspace's connected account. It claims
 * `execution.pause-resume` with `preserves: "filesystem"`: archiving and the
 * idle deadline snapshot the filesystem and stop the container, and the
 * next activation restores it (dxd restarts from the image entrypoint).
 * Destroying stops it and forgets the snapshot.
 */
export const cloudflareExecutionProvider: ExecutionProvider<CloudflareWorkspaceHandle> =
  {
    workspace: {
      create: (context, { threadId }, options) => {
        const { onPreparationPhase } = options as CloudflareOpenPhaseReporter;
        return openCloudflareWorkspace(context, threadId, {
          existingOnly: false,
          authorize: options.authorize,
          ...(options.observeResidency === undefined
            ? {}
            : { observeResidency: options.observeResidency }),
          ...(onPreparationPhase === undefined ? {} : { onPreparationPhase }),
        });
      },
      connect: (context, { threadId }, options) =>
        openCloudflareWorkspace(context, threadId, {
          existingOnly: true,
          authorize: options.authorize,
        }),
      async release(context, { threadId }, mode) {
        cloudflareProfile(context.profile);
        const bindings = env as Bindings;
        const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
        const records = executionWorkspaceRecords(db, CLOUDFLARE);
        const record = await readRecord(records, threadId);
        if (record.state === "uninitialized") return;
        if (record.provider !== CLOUDFLARE) throw unavailable("other provider");
        if (mode === "destroy" && record.state === "lost") return;
        // Provisioning or conflict fails closed, as on E2B.
        if (record.state !== "initialized") throw unavailable(record.state);
        const { stub } = orbContainer(context, bindings, threadId);
        if (mode === "archive") {
          await assertThreadLifecycleState(db, threadId, "archived");
          await stub.pause();
          return;
        }
        await stub.destroy();
        await records.markLost(threadId);
      },
    },
    // The same guest installer as E2B: the standard Orb image's entrypoint
    // supervises dxd, so the bootstrap needs no root and no systemd.
    residentDaemon: guestResidentDaemon(),
  };
