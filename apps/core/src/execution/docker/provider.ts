import { env } from "cloudflare:workers";
import { type DockerRunnerProfileConfiguration, ThreadId } from "@dx/domain";
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
import { orbGuest, orbGuestSandbox } from "../guest/orb-guest-client.js";
import {
  type DaemonGuestHandle,
  guestResidentDaemon,
} from "../guest/resident-daemon.js";
import {
  type ExecutionWorkspaceRecord,
  executionWorkspaceRecords,
} from "../workspace-record.js";
import {
  type DockerSandbox,
  type DockerSandboxesApi,
  DockerSandboxesApiError,
  dockerSandboxesApi,
} from "./api.js";
import { dockerGuestClient } from "./guest.js";

const DOCKER = "docker";
const COMMAND_TIMEOUT_MS = 300_000;
const MIN_INACTIVITY_MS = 60_000;
const MAX_INACTIVITY_MS = 3_600_000;
const STATE_RETRIES = 3;
/** A first boot pulls the Orb image, which takes longer than a resume. */
const CREATE_TIMEOUT_MS = 600_000;
const START_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

export class DockerWorkspaceUnavailable extends Schema.TaggedError<DockerWorkspaceUnavailable>()(
  "DockerWorkspaceUnavailable",
  { reason: Schema.String },
) {}

const unavailable = (reason: string) =>
  new DockerWorkspaceUnavailable({ reason });

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

const dockerProfile = (
  profile: ExecutionContext["profile"],
): DockerRunnerProfileConfiguration => {
  if (profile.adapter !== DOCKER)
    throw unavailable("Docker execution requires a Docker profile.");
  return profile;
};

/** Docker Sandboxes run only on a person's or workspace's own account. */
const apiFor = (context: ExecutionContext, send?: typeof fetch) => {
  const credentials =
    context.credentials === undefined
      ? undefined
      : Redacted.value(context.credentials);
  const dockerId = credentials?.dockerId;
  const accessToken = credentials?.accessToken;
  if (
    context.account.scope === "deployment" ||
    dockerId === undefined ||
    accessToken === undefined
  )
    throw unavailable("no Docker connection");
  return dockerSandboxesApi({ dockerId, accessToken }, send);
};

/** The sandbox's display name: one per Thread, so a retried create finds it. */
export const dockerSandboxName = (threadId: string) => `dx-${threadId}`;

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1_000));

const conflict = (cause: unknown) =>
  cause instanceof DockerSandboxesApiError &&
  (cause.status === 409 || cause.status === 412);

/** Polls until the sandbox runs; a sandbox that stops or fails is refused. */
const untilRunning = async (
  api: DockerSandboxesApi,
  uid: string,
  timeoutMs: number,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await api.getSandbox(uid);
    if (current === undefined || current.status === "deleting")
      throw unavailable("sandbox gone");
    if (current.status === "running") return current;
    if (current.status === "failed")
      throw unavailable(`sandbox failed: ${current.failure ?? "unknown"}`);
    if (current.status === "stopped" || current.status === "stopping")
      throw unavailable(`sandbox ${current.status}`);
    if (Date.now() > deadline) throw unavailable(`sandbox ${current.status}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
};

/**
 * Starts a stopped sandbox. Docker restarts its deadline at the length it
 * was created with (one idle window), so a wake needs no renewal.
 */
const wake = async (api: DockerSandboxesApi, current: DockerSandbox) => {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let sandbox = current;
  while (sandbox.status !== "running") {
    if (sandbox.status === "failed")
      throw unavailable(`sandbox failed: ${sandbox.failure ?? "unknown"}`);
    if (sandbox.status === "deleting") throw unavailable("sandbox gone");
    if (sandbox.status === "stopped")
      await api.startSandbox(sandbox).catch((cause: unknown) => {
        // Another activation started it first.
        if (!conflict(cause)) throw cause;
      });
    if (Date.now() > deadline) throw unavailable(`sandbox ${sandbox.status}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const next = await api.getSandbox(sandbox.uid);
    if (next === undefined) throw unavailable("sandbox gone");
    sandbox = next;
  }
  return sandbox;
};

const handleFor = (
  api: DockerSandboxesApi,
  uid: string,
  idleMs: number,
  processesStartedAt?: number,
): DaemonGuestHandle => {
  const client = dockerGuestClient(api.endpoint(uid));
  return {
    guest: orbGuest(client),
    sandbox: async (cwd) => orbGuestSandbox(client, cwd),
    // Docker stops the sandbox at its own deadline; Core moves it while
    // the Orb is in use, because dxd's open WebSocket never looks idle.
    setIdleDeadline: (durationMs) => api.renewTimeout(uid, seconds(durationMs)),
    inactivityMs: idleMs,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    ...(processesStartedAt === undefined ? {} : { processesStartedAt }),
  };
};

const createSandbox = async (
  api: DockerSandboxesApi,
  profile: DockerRunnerProfileConfiguration,
  threadId: string,
  record: ExecutionWorkspaceRecord,
  idleMs: number,
) => {
  if (profile.image === undefined) throw unavailable("no prepared Orb image");
  const displayName = dockerSandboxName(threadId);
  const created = await api
    .createSandbox({
      imageRef: profile.image,
      cpus: profile.resources.cpuCores,
      memoryMib: profile.resources.memoryMb,
      timeoutSeconds: seconds(idleMs),
      onTimeout: "stop",
      displayName,
      labels: { dxThread: threadId },
      idempotencyKey: `${displayName}-${record.initializationAttemptId ?? "0"}`,
    })
    .catch(async (cause: unknown) => {
      // A create that reached Docker before an earlier attempt failed.
      if (cause instanceof DockerSandboxesApiError && cause.status === 409) {
        const existing = await api.findSandbox(displayName);
        if (existing !== undefined) return existing;
      }
      throw cause;
    });
  return untilRunning(api, created.uid, CREATE_TIMEOUT_MS);
};

/**
 * Creates (on the first activation) or reconnects to the Thread's sandbox.
 * The D1 record pins the provider and the sandbox ID; the sandbox keeps
 * its size and disk.
 */
const openDockerWorkspace = async (
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
  const profile = dockerProfile(context.profile);
  const api = apiFor(context, send);
  const idleMs = await inactivityMs(bindings);
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const records = executionWorkspaceRecords(db, DOCKER);
  const id = Schema.decodeUnknownSync(ThreadId)(threadId);
  for (let attempt = 0; attempt < STATE_RETRIES; attempt += 1) {
    const record = await records.read(id);
    if (record === null) throw unavailable("no workspace record");
    if (record.state === "uninitialized") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      await records.claim(id);
      continue;
    }
    // Pinned to another provider: never reached through this one.
    if (record.provider !== DOCKER) throw unavailable("other provider");
    if (record.state === "provisioning") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      const startedAt = Date.now();
      const sandbox = await createSandbox(api, profile, id, record, idleMs);
      if (!(await records.initialize(id, record, sandbox.uid))) continue;
      return handleFor(api, sandbox.uid, idleMs, startedAt);
    }
    return reconnect(api, records, id, record, idleMs, options);
  }
  throw unavailable("contended");
};

const reconnect = async (
  api: DockerSandboxesApi,
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
  const sandbox = await api.getSandbox(record.providerSandboxId);
  if (sandbox === undefined || sandbox.status === "deleting") {
    await records.markLost(threadId);
    throw unavailable("sandbox gone");
  }
  await options.observeResidency?.(
    sandbox.status === "running" ? "running" : "paused",
  );
  await options.authorize();
  if (sandbox.status === "running") return handleFor(api, sandbox.uid, idleMs);
  // A creating or starting sandbox is already on its way up.
  if (sandbox.status === "creating" || sandbox.status === "starting")
    return handleFor(
      api,
      (await untilRunning(api, sandbox.uid, START_TIMEOUT_MS)).uid,
      idleMs,
    );
  const startedAt = Date.now();
  const running = await wake(api, sandbox);
  return handleFor(api, running.uid, idleMs, startedAt);
};

/**
 * Docker Cloud Sandboxes (https://docs.docker.com/ai/sandboxes-api/), one
 * microVM per Thread in a person's or workspace's own Docker account,
 * booted from the public Orb image its connection tested (connector.ts).
 * It claims `execution.pause-resume` with `preserves: "filesystem"`:
 * archiving and the idle deadline stop the sandbox, and the next
 * activation starts it again. Destroying deletes it.
 */
export const makeDockerExecutionProvider = (
  options: { readonly fetch?: typeof fetch } = {},
): ExecutionProvider<DaemonGuestHandle> => ({
  workspace: {
    create: (context, { threadId }, open) =>
      openDockerWorkspace(context, threadId, options.fetch, {
        existingOnly: false,
        authorize: open.authorize,
        ...(open.observeResidency === undefined
          ? {}
          : { observeResidency: open.observeResidency }),
      }),
    connect: (context, { threadId }, open) =>
      openDockerWorkspace(context, threadId, options.fetch, {
        existingOnly: true,
        authorize: open.authorize,
      }),
    async release(context, { threadId }, mode) {
      dockerProfile(context.profile);
      const bindings = env as Bindings;
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      const records = executionWorkspaceRecords(db, DOCKER);
      const record = await records.read(threadId);
      if (record === null) throw unavailable("no workspace record");
      if (record.state === "uninitialized") return;
      if (record.provider !== DOCKER) throw unavailable("other provider");
      if (mode === "destroy" && record.state === "lost") return;
      // Provisioning or conflict fails closed, as on E2B.
      if (record.state !== "initialized" || record.providerSandboxId === null)
        throw unavailable(record.state);
      const api = apiFor(context, options.fetch);
      if (mode === "archive") {
        await assertThreadLifecycleState(db, threadId, "archived");
        const sandbox = await api.getSandbox(record.providerSandboxId);
        if (
          sandbox === undefined ||
          (sandbox.status !== "running" && sandbox.status !== "starting")
        )
          return;
        await api.stopSandbox(sandbox).catch((cause: unknown) => {
          // Already stopping or stopped.
          if (!conflict(cause)) throw cause;
        });
        return;
      }
      await api.deleteSandbox(record.providerSandboxId);
      await records.markLost(threadId);
    },
  },
  residentDaemon: guestResidentDaemon(),
});

export const dockerExecutionProvider = makeDockerExecutionProvider();
