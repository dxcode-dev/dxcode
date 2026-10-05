import { env } from "cloudflare:workers";
import {
  type CloudflareRunnerProfileConfiguration,
  ThreadId,
} from "@dx/domain";
import { Config, ConfigProvider, Effect, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import type {
  ExecutionContext,
  ExecutionProvider,
  ExecutionWorkspaceHandle,
  ExecutionWorkspaceResidency,
} from "../../plugins/execution/provider.js";
import {
  assertThreadLifecycleState,
  atDaemonInstallationStage,
} from "../activation.js";
import { DEFAULT_WORKSPACE_INACTIVITY_MS } from "../activity.js";
import {
  type DaemonGuest,
  ensureDaemonInGuest,
} from "../e2b/daemon-installer.js";
import {
  loadDaemonRelease,
  loadDaemonReleaseMetadata,
} from "../e2b/daemon-release.js";
import {
  cloudflareGuest,
  cloudflareSandbox,
  type OrbContainerClient,
} from "./driver.js";
import type { OrbOpenResult } from "./orb-container.js";

/** Default limit for one agent command, as E2B's sandbox timeout. */
export const DEFAULT_CLOUDFLARE_COMMAND_TIMEOUT_MS = 300_000;
const MIN_INACTIVITY_MS = 60_000;
const MAX_INACTIVITY_MS = 3_600_000;
const STATE_RETRIES = 3;

export class CloudflareWorkspaceUnavailable extends Schema.TaggedError<CloudflareWorkspaceUnavailable>()(
  "CloudflareWorkspaceUnavailable",
  { reason: Schema.String },
) {}

const unavailable = (reason: string) =>
  new CloudflareWorkspaceUnavailable({ reason });

const InactivityMs = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: MIN_INACTIVITY_MS, maximum: MAX_INACTIVITY_MS }),
);

const inactivityMs = (bindings: Bindings) =>
  Effect.runPromise(
    Config.number("DX_WORKSPACE_INACTIVITY_MS")
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

/**
 * The Thread's row in `execution_workspace`, which pins its provider and
 * sandbox identity. A new Thread's row says `e2b` until its first
 * activation; the Containers provider claims it while `uninitialized`
 * (migration 0064 allows exactly that one change).
 */
interface WorkspaceRecord {
  readonly provider: string;
  readonly state: string;
  readonly providerSandboxId: string | null;
  readonly initializationAttemptId: string | null;
}

const readRecord = async (
  db: D1Database,
  threadId: string,
): Promise<WorkspaceRecord> => {
  const row = await db
    .prepare(
      `SELECT provider, state, provider_sandbox_id, initialization_attempt_id
         FROM execution_workspace
        WHERE thread_id = ?
        LIMIT 1`,
    )
    .bind(threadId)
    .first<{
      provider: string;
      state: string;
      provider_sandbox_id: string | null;
      initialization_attempt_id: string | null;
    }>();
  if (row === null) throw unavailable("no workspace record");
  return {
    provider: row.provider,
    state: row.state,
    providerSandboxId: row.provider_sandbox_id,
    initializationAttemptId: row.initialization_attempt_id,
  };
};

const claim = async (db: D1Database, threadId: string) =>
  (
    await db
      .prepare(
        `UPDATE execution_workspace
            SET provider = 'cloudflare',
                state = 'provisioning',
                initialization_attempt_id = ?,
                updated_at = ?
          WHERE thread_id = ? AND state = 'uninitialized'`,
      )
      .bind(crypto.randomUUID(), new Date().toISOString(), threadId)
      .run()
  ).meta.changes === 1;

const initialize = async (
  db: D1Database,
  threadId: string,
  record: WorkspaceRecord,
  sandboxId: string,
) =>
  (
    await db
      .prepare(
        `UPDATE execution_workspace
            SET state = 'initialized',
                provider_sandbox_id = ?,
                initialization_attempt_id = NULL,
                updated_at = ?
          WHERE thread_id = ?
            AND provider = 'cloudflare'
            AND state = 'provisioning'
            AND initialization_attempt_id IS ?`,
      )
      .bind(
        sandboxId,
        new Date().toISOString(),
        threadId,
        record.initializationAttemptId,
      )
      .run()
  ).meta.changes === 1;

const markLost = (db: D1Database, threadId: string) =>
  db
    .prepare(
      `UPDATE execution_workspace
          SET state = 'lost', updated_at = ?
        WHERE thread_id = ?
          AND provider = 'cloudflare'
          AND state = 'initialized'`,
    )
    .bind(new Date().toISOString(), threadId)
    .run();

/** Each Thread's workspace is the Orb container object named by its ID. */
const orbContainer = (bindings: Bindings, threadId: string) => {
  const namespace = bindings.ORB_CONTAINER;
  if (namespace === undefined) throw unavailable("no ORB_CONTAINER binding");
  return namespace.get(namespace.idFromName(threadId));
};

type OrbContainerStub = ReturnType<typeof orbContainer>;

/** The raw workspace Core's pipeline prepares, over the container object. */
interface CloudflareWorkspaceHandle extends ExecutionWorkspaceHandle {
  readonly guest: ExecutionWorkspaceHandle["guest"] & DaemonGuest;
}

const handleFor = (
  stub: OrbContainerStub,
  idleMs: number,
  processesStartedAt: number | undefined,
): CloudflareWorkspaceHandle => {
  const client = stub as unknown as OrbContainerClient;
  return {
    guest: cloudflareGuest(client),
    sandbox: async (cwd) => cloudflareSandbox(client, cwd),
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
  },
): Promise<CloudflareWorkspaceHandle> => {
  const bindings = env as Bindings;
  const profile = cloudflareProfile(context.profile);
  const idleMs = await inactivityMs(bindings);
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const id = Schema.decodeUnknownSync(ThreadId)(threadId);
  const stub = orbContainer(bindings, id);
  const sandboxId = stub.id.toString();
  const ready = (result: OrbOpenResult) => {
    if (result.kind === "ready")
      return handleFor(stub, idleMs, result.processesStartedAt);
    throw unavailable(`container ${result.kind}`);
  };
  for (let attempt = 0; attempt < STATE_RETRIES; attempt += 1) {
    const record = await readRecord(db, id);
    if (record.state === "uninitialized") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      await claim(db, id);
      continue;
    }
    // Pinned to another provider: never reached through this one.
    if (record.provider !== "cloudflare") throw unavailable("other provider");
    if (record.state === "provisioning") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      const result = await stub.open({
        create: true,
        instance: profile.instance,
        idleMs,
      });
      const handle = ready(result);
      if (!(await initialize(db, id, record, sandboxId))) continue;
      return handle;
    }
    if (
      record.state !== "initialized" ||
      record.providerSandboxId !== sandboxId
    )
      throw unavailable(record.state);
    if (options.observeResidency !== undefined) {
      const status = await stub.status();
      await options.observeResidency(status.running ? "running" : "paused");
    }
    await options.authorize();
    const result = await stub.open({
      create: false,
      instance: profile.instance,
      idleMs,
    });
    if (result.kind !== "ready") {
      await markLost(db, id);
      throw unavailable(`container ${result.kind}`);
    }
    return handleFor(stub, idleMs, result.processesStartedAt);
  }
  throw unavailable("contended");
};

/**
 * The second Execution provider: Cloudflare Containers, one container per
 * Thread owned by a Durable Object in the deployer's account. It claims
 * `execution.pause-resume` with `preserves: "filesystem"`: archiving and the
 * idle deadline snapshot the filesystem and stop the container, and the
 * next activation restores it (dxd restarts from the image entrypoint).
 * Destroying stops it and forgets the snapshot.
 */
export const cloudflareExecutionProvider: ExecutionProvider<CloudflareWorkspaceHandle> =
  {
    workspace: {
      create: (context, { threadId }, options) =>
        openCloudflareWorkspace(context, threadId, {
          existingOnly: false,
          authorize: options.authorize,
          ...(options.observeResidency === undefined
            ? {}
            : { observeResidency: options.observeResidency }),
        }),
      connect: (context, { threadId }, options) =>
        openCloudflareWorkspace(context, threadId, {
          existingOnly: true,
          authorize: options.authorize,
        }),
      async release(context, { threadId }, mode) {
        cloudflareProfile(context.profile);
        const bindings = env as Bindings;
        const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
        const record = await readRecord(db, threadId);
        if (record.state === "uninitialized") return;
        if (record.provider !== "cloudflare")
          throw unavailable("other provider");
        if (mode === "destroy" && record.state === "lost") return;
        // Provisioning or conflict fails closed, as on E2B.
        if (record.state !== "initialized") throw unavailable(record.state);
        const stub = orbContainer(bindings, threadId);
        if (mode === "archive") {
          await assertThreadLifecycleState(db, threadId, "archived");
          await stub.pause();
          return;
        }
        await stub.destroy();
        await markLost(db, threadId);
      },
    },
    residentDaemon: {
      // The same guest installer as E2B: the standard Orb image's entrypoint
      // supervises dxd, so the bootstrap needs no root and no systemd.
      async install(_context, handle, input) {
        const bindings = env as Bindings;
        const release = await atDaemonInstallationStage(
          "release",
          loadDaemonReleaseMetadata(bindings),
        );
        let releaseLoadedAt: number | undefined;
        const guest = await ensureDaemonInGuest(handle.guest, {
          threadId: input.threadId,
          endpoint: input.endpoint,
          sha256: release.sha256,
          releaseUrl: release.url,
          credential: input.credential,
          mintCredential: input.mintCredential,
          loadBinary: async () => {
            const loaded = await atDaemonInstallationStage(
              "release",
              loadDaemonRelease(bindings),
            );
            releaseLoadedAt = Date.now();
            return loaded.binary;
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return {
          guest,
          ...(releaseLoadedAt === undefined ? {} : { releaseLoadedAt }),
        };
      },
    },
  };
