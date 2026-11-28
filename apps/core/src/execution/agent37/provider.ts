import { env } from "cloudflare:workers";
import { type Agent37RunnerProfileConfiguration, ThreadId } from "@dx/domain";
import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import type {
  ExecutionContext,
  ExecutionProvider,
  ExecutionWorkspaceResidency,
} from "../../plugins/execution/provider.js";
import { assertThreadLifecycleState } from "../activation.js";
import { DEFAULT_WORKSPACE_INACTIVITY_MS } from "../activity.js";
import {
  openClaimedSandbox,
  removeStraySandboxes,
} from "../claimed-sandbox.js";
import { orbGuest, orbGuestSandbox } from "../guest/orb-guest-client.js";
import {
  type DaemonGuestHandle,
  guestResidentDaemon,
} from "../guest/resident-daemon.js";
import {
  clearIdleDeadline,
  idleOrbCredentials,
  setIdleDeadline,
} from "../idle-deadlines.js";
import {
  type ExecutionWorkspaceRecord,
  executionWorkspaceRecords,
} from "../workspace-record.js";
import {
  type Agent37Api,
  Agent37ApiError,
  type Agent37Instance,
  agent37Api,
} from "./api.js";
import { agent37GuestClient } from "./guest.js";

const AGENT37 = "agent37";
const COMMAND_TIMEOUT_MS = 300_000;
const MIN_INACTIVITY_MS = 60_000;
const MAX_INACTIVITY_MS = 3_600_000;
/** A create, start, or wake waits this long for the instance to run. */
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;

/**
 * Where the instance's own disk mounts. Agent37 hides whatever the image
 * ships under the mount (`/home/user` would lose the Orb's dotfiles and
 * Claude Code), so only the workspace takes the billed disk; the rest of
 * the filesystem is the instance's system layer, which also persists.
 */
export const AGENT37_MOUNT_PATH = "/home/user/workspace";

/** States a start brings back: asleep with memory, or stopped. */
const RESTING = new Set(["sleeping", "stopped"]);
/** States on the way to `running`, or to rest. */
const TRANSITIONING = new Set([
  "provisioning",
  "starting",
  "waking",
  "restarting",
  "updating",
  "stopping",
]);
/** States an instance never comes back from. */
const GONE = new Set(["failed", "deleting", "deleted"]);

export class Agent37WorkspaceUnavailable extends Schema.TaggedError<Agent37WorkspaceUnavailable>()(
  "Agent37WorkspaceUnavailable",
  { reason: Schema.String },
) {}

const unavailable = (reason: string) =>
  new Agent37WorkspaceUnavailable({ reason });

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

const agent37Profile = (
  profile: ExecutionContext["profile"],
): Agent37RunnerProfileConfiguration => {
  if (profile.adapter !== AGENT37)
    throw unavailable("Agent37 execution requires an Agent37 profile.");
  return profile;
};

/**
 * Agent37 runs on a person's or workspace's own account, or on a
 * deployment Orb account its admin added in the panel, whose key the
 * composition passes in the context and which never leaves the Worker.
 */
const apiFor = (context: ExecutionContext, send?: typeof fetch) => {
  const apiKey =
    context.credentials === undefined
      ? undefined
      : Redacted.value(context.credentials).apiKey;
  if (apiKey === undefined) throw unavailable("no Agent37 account");
  return agent37Api(apiKey, send);
};

/** What Agent37 refused, in its own words, for the Thread's error card. */
const refused = (cause: unknown) => {
  if (!(cause instanceof Agent37ApiError)) return cause;
  if (cause.status === 402)
    return unavailable(
      `Agent37 needs more balance in its workspace wallet: ${cause.message}`,
    );
  if (cause.code === "instance_limit_reached" || cause.code === "no_capacity")
    return unavailable(`Agent37 refused the Orb: ${cause.message}`);
  return cause;
};

/** Polls until the instance runs commands, starting it if it rests. */
const untilRunning = async (api: Agent37Api, id: string) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let started = false;
  for (;;) {
    const current = await api.getInstance(id);
    if (current === undefined) throw unavailable("instance gone");
    if (current.status === "running") return current;
    if (GONE.has(current.status))
      throw unavailable(`instance ${current.status}`);
    if (RESTING.has(current.status) && !started) {
      started = true;
      await api.start(id).catch((cause: unknown) => {
        // Another activation is starting it already.
        if (!(cause instanceof Agent37ApiError && cause.status === 409))
          throw refused(cause);
      });
    } else if (
      !TRANSITIONING.has(current.status) &&
      !RESTING.has(current.status)
    )
      throw unavailable(`instance ${current.status}`);
    if (Date.now() > deadline) throw unavailable(`instance ${current.status}`);
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
};

/**
 * When the Orb's processes started (epoch ms): dx-orb-init, the image's
 * entrypoint, which a start runs again. A wake from sleep keeps it (and
 * every process), so a Terminal shell ready before the sleep is still
 * there; a stop ends it.
 */
const ORB_STARTED_AT =
  'for _ in $(seq 1 30); do pid=$(cat /home/user/.local/state/dxd/supervisor.pid 2>/dev/null); test "$pid" -gt 0 2>/dev/null && kill -0 "$pid" 2>/dev/null && break; pid=; sleep 1; done; test -n "$pid" && echo $(( $(date +%s) - $(ps -o etimes= -p "$pid") ))';

const orbStartedAt = async (api: Agent37Api, id: string) => {
  const result = await api
    .exec(id, ORB_STARTED_AT, { timeoutSeconds: 60 })
    .catch(() => undefined);
  const seconds = Number(result?.stdout.trim());
  return result?.exitCode === 0 && Number.isSafeInteger(seconds) && seconds > 0
    ? seconds * 1_000
    : undefined;
};

const handleFor = async (
  api: Agent37Api,
  db: D1Database,
  threadId: string,
  instanceId: string,
  idleMs: number,
): Promise<DaemonGuestHandle> => {
  const client = agent37GuestClient(api, instanceId);
  const processesStartedAt = await orbStartedAt(api, instanceId);
  return {
    guest: orbGuest(client),
    sandbox: async (cwd) => orbGuestSandbox(client, cwd),
    // Agent37's own auto-sleep counts only requests to the instance's URLs,
    // never dxd's connection out to Core, so Core sleeps it at this
    // deadline (idle-deadlines.ts).
    setIdleDeadline: (durationMs) =>
      setIdleDeadline(
        db,
        { providerId: AGENT37, sandboxId: instanceId, threadId },
        durationMs,
      ),
    inactivityMs: idleMs,
    ...(processesStartedAt === undefined ? {} : { processesStartedAt }),
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  };
};

/** Instance metadata naming the Thread, and the claim attempt that made it. */
const THREAD_TAG = "dxThread";
const ATTEMPT_TAG = "dxAttempt";

/** Creates the Thread's instance for claim `attempt`; returns its ID. */
const createInstance = async (
  api: Agent37Api,
  profile: Agent37RunnerProfileConfiguration,
  threadId: string,
  attempt: string,
) => {
  if (profile.template === undefined)
    throw unavailable("no prepared Orb template");
  const created = await api
    .createInstance({
      template: profile.template,
      resources: {
        cpu: profile.resources.cpuCores,
        memory: Math.round(profile.resources.memoryMb / 1024),
        disk: profile.resources.diskGb,
      },
      name: `dx ${threadId}`,
      mountPath: AGENT37_MOUNT_PATH,
      metadata: { [THREAD_TAG]: threadId, [ATTEMPT_TAG]: attempt },
      ...(profile.instanceType === "vm" ? { type: "vm" as const } : {}),
    })
    .catch((cause: unknown) => {
      throw refused(cause);
    });
  return created.id;
};

/** The account's instances made for the Thread. */
const taggedInstances = async (api: Agent37Api, threadId: string) =>
  (await api.instances())
    .filter(
      ({ metadata, status }) =>
        metadata?.[THREAD_TAG] === threadId && !GONE.has(status),
    )
    .map(({ id, metadata }) => ({
      id,
      ...(metadata?.[ATTEMPT_TAG] === undefined
        ? {}
        : { attempt: metadata[ATTEMPT_TAG] }),
    }));

/**
 * Creates (on the first activation) or reconnects to the Thread's
 * instance. The D1 record pins the provider and the instance ID; the
 * instance keeps its size and disk, and a sleep keeps its memory.
 */
const openAgent37Workspace = async (
  context: ExecutionContext,
  threadId: string,
  send: typeof fetch | undefined,
  options: {
    readonly existingOnly: boolean;
    readonly authorize: () => Promise<void>;
    readonly observeResidency?: (
      residency: ExecutionWorkspaceResidency,
    ) => void | Promise<void>;
  },
): Promise<DaemonGuestHandle> => {
  const bindings = env as Bindings;
  const profile = agent37Profile(context.profile);
  const api = apiFor(context, send);
  const idleMs =
    context.inactivityMs === undefined
      ? await inactivityMs(bindings)
      : Math.min(
          MAX_INACTIVITY_MS,
          Math.max(MIN_INACTIVITY_MS, context.inactivityMs),
        );
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const records = executionWorkspaceRecords(db, AGENT37);
  const id = Schema.decodeUnknownSync(ThreadId)(threadId);
  const opened = await openClaimedSandbox(
    records,
    id,
    {
      tagged: (thread) => taggedInstances(api, thread),
      create: (thread, attempt) =>
        createInstance(api, profile, thread, attempt),
      remove: (instanceId) => api.deleteInstance(instanceId),
      // A refusal (no balance, no capacity, a bad template) makes nothing.
      refused: (cause) =>
        cause instanceof Agent37WorkspaceUnavailable ||
        (cause instanceof Agent37ApiError &&
          cause.status >= 400 &&
          cause.status < 500 &&
          cause.status !== 408),
    },
    {
      provider: AGENT37,
      existingOnly: options.existingOnly,
      authorize: options.authorize,
      unavailable,
    },
  );
  if (opened.kind === "recorded")
    return reconnect(api, db, records, id, opened.record, idleMs, options);
  await untilRunning(api, opened.sandboxId);
  return handleFor(api, db, id, opened.sandboxId, idleMs);
};

const reconnect = async (
  api: Agent37Api,
  db: D1Database,
  records: ReturnType<typeof executionWorkspaceRecords>,
  threadId: string,
  record: ExecutionWorkspaceRecord,
  idleMs: number,
  options: {
    readonly authorize: () => Promise<void>;
    readonly observeResidency?: (
      residency: ExecutionWorkspaceResidency,
    ) => void | Promise<void>;
  },
) => {
  if (record.state !== "initialized" || record.providerSandboxId === null)
    throw unavailable(record.state);
  const instanceId = record.providerSandboxId;
  const instance: Agent37Instance | undefined =
    await api.getInstance(instanceId);
  if (instance === undefined || GONE.has(instance.status)) {
    await records.markLost(threadId);
    await clearIdleDeadline(db, AGENT37, instanceId);
    throw unavailable(
      instance === undefined ? "instance gone" : `instance ${instance.status}`,
    );
  }
  await options.observeResidency?.(
    RESTING.has(instance.status) ? "paused" : "running",
  );
  await options.authorize();
  await untilRunning(api, instanceId);
  return handleFor(api, db, threadId, instanceId, idleMs);
};

/** Sleeps a running instance; one already resting or gone needs nothing. */
export const sleepAgent37Instance = async (
  api: Agent37Api,
  instanceId: string,
) => {
  const instance = await api.getInstance(instanceId);
  if (instance?.status !== "running") return;
  await api.sleep(instanceId).catch((cause: unknown) => {
    // Already going to sleep or stopping.
    if (!(cause instanceof Agent37ApiError && cause.status === 409))
      throw cause;
  });
};

/**
 * Sleeps an idle instance (the idle sweep's Agent37 pauser). The sweep
 * knows only the Thread, so the key is the one its pin resolves to: the
 * deployment's, or the person's or workspace's connection.
 */
export const pauseIdleAgent37Instance = async (
  bindings: Bindings,
  instanceId: string,
  threadId: string,
  send?: typeof fetch,
) => {
  const apiKey = (await idleOrbCredentials(bindings, threadId))?.apiKey;
  if (apiKey === undefined) throw unavailable("no Agent37 account");
  const api = agent37Api(apiKey, send);
  await sleepAgent37Instance(api, instanceId);
  // An instance an interrupted create left behind for this Thread, or one
  // from before creates were claimed, is never slept here: it has no idle
  // deadline. Delete it while its Thread's own instance is recorded.
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const record = await executionWorkspaceRecords(db, AGENT37).read(threadId);
  if (
    record?.state === "initialized" &&
    record.providerSandboxId === instanceId
  )
    await removeStraySandboxes(
      {
        tagged: (thread) => taggedInstances(api, thread),
        remove: (id) => api.deleteInstance(id),
      },
      AGENT37,
      threadId,
      instanceId,
    );
};

/**
 * Agent37 instances (https://www.agent37.com), one per Thread, in a
 * person's or workspace's own Agent37 workspace or the deployment's. Every
 * size starts from the dx Orb template that account's preparation
 * registered from the public Orb image (connector.ts). Agent37's sleep
 * keeps memory, so processes resume in place (`execution.pause-resume`,
 * `processes`); its auto-sleep cannot see dxd's traffic, so the handle's
 * idle deadline lives in D1 and the Worker's cron sleeps the instance
 * there. Archiving sleeps it, the next activation starts it, and
 * destroying deletes it.
 */
export const makeAgent37ExecutionProvider = (
  options: { readonly fetch?: typeof fetch } = {},
): ExecutionProvider<DaemonGuestHandle> => ({
  workspace: {
    create: (context, { threadId }, open) =>
      openAgent37Workspace(context, threadId, options.fetch, {
        existingOnly: false,
        authorize: open.authorize,
        ...(open.observeResidency === undefined
          ? {}
          : { observeResidency: open.observeResidency }),
      }),
    connect: (context, { threadId }, open) =>
      openAgent37Workspace(context, threadId, options.fetch, {
        existingOnly: true,
        authorize: open.authorize,
      }),
    async release(context, { threadId }, mode) {
      agent37Profile(context.profile);
      const bindings = env as Bindings;
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      const records = executionWorkspaceRecords(db, AGENT37);
      const record = await records.read(threadId);
      if (record === null) throw unavailable("no workspace record");
      if (record.state === "uninitialized") return;
      if (record.provider !== AGENT37) throw unavailable("other provider");
      if (mode === "destroy" && record.state === "lost") return;
      // Provisioning or conflict fails closed, as on E2B.
      if (record.state !== "initialized" || record.providerSandboxId === null)
        throw unavailable(record.state);
      const instanceId = record.providerSandboxId;
      const api = apiFor(context, options.fetch);
      if (mode === "archive") {
        await assertThreadLifecycleState(db, threadId, "archived");
        await sleepAgent37Instance(api, instanceId);
        await clearIdleDeadline(db, AGENT37, instanceId);
        return;
      }
      await api.deleteInstance(instanceId);
      await clearIdleDeadline(db, AGENT37, instanceId);
      await records.markLost(threadId);
    },
  },
  residentDaemon: guestResidentDaemon(),
});

export const agent37ExecutionProvider = makeAgent37ExecutionProvider();
