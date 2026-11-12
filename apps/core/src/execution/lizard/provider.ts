import { env } from "cloudflare:workers";
import { type LizardRunnerProfileConfiguration, ThreadId } from "@dx/domain";
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
import { clearIdleDeadline, setIdleDeadline } from "../idle-deadlines.js";
import {
  type ExecutionWorkspaceRecord,
  executionWorkspaceRecords,
} from "../workspace-record.js";
import {
  type LizardApi,
  LizardApiError,
  type LizardSandbox,
  lizardApi,
} from "./api.js";
import { lizardGuestClient } from "./guest.js";

const LIZARD = "lizard";
const COMMAND_TIMEOUT_MS = 300_000;
const MIN_INACTIVITY_MS = 60_000;
const MAX_INACTIVITY_MS = 3_600_000;
const STATE_RETRIES = 3;
/** A create or resume waits this long for the sandbox to run commands. */
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;

/** States a resume brings back. */
const PAUSED = new Set(["pausing", "paused"]);
/** States on the way to running. */
const STARTING = new Set(["starting", "resuming"]);
/** States a sandbox never comes back from: its disk is gone. */
const GONE = new Set(["stopped", "crashed", "killed", "deleted"]);

export class LizardWorkspaceUnavailable extends Schema.TaggedError<LizardWorkspaceUnavailable>()(
  "LizardWorkspaceUnavailable",
  { reason: Schema.String },
) {}

const unavailable = (reason: string) =>
  new LizardWorkspaceUnavailable({ reason });

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

const lizardProfile = (
  profile: ExecutionContext["profile"],
): LizardRunnerProfileConfiguration => {
  if (profile.adapter !== LIZARD)
    throw unavailable("Lizard execution requires a Lizard profile.");
  return profile;
};

/**
 * Lizard runs only on the deployment's own account (LIZARD_API_KEY, its
 * LIZARD_PROJECT_ID, and LIZARD_REGION), which the key composition passes
 * in the context and which never leaves the Worker.
 */
const apiFor = (context: ExecutionContext, send?: typeof fetch) => {
  const credentials =
    context.credentials === undefined
      ? undefined
      : Redacted.value(context.credentials);
  if (credentials?.apiKey === undefined || credentials.projectId === undefined)
    throw unavailable("no Lizard account");
  return lizardApi(
    credentials.apiKey,
    credentials.projectId,
    send,
    credentials.region,
  );
};

/** The deployment's Lizard account, for the idle sweep (no context). */
export const deploymentLizardApi = (
  bindings: Bindings,
  send?: typeof fetch,
): LizardApi | undefined => {
  const apiKey = (bindings.LIZARD_API_KEY ?? "").trim();
  const projectId = (bindings.LIZARD_PROJECT_ID ?? "").trim();
  if (apiKey === "" || projectId === "") return undefined;
  const region = (bindings.LIZARD_REGION ?? "").trim();
  return lizardApi(apiKey, projectId, send, region === "" ? undefined : region);
};

/** Polls until the sandbox runs commands. */
const untilRunning = async (api: LizardApi, id: string) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const current = await api.getSandbox(id);
    if (current === undefined) throw unavailable("sandbox gone");
    if (current.status === "running") return current;
    if (!STARTING.has(current.status) && !PAUSED.has(current.status))
      throw unavailable(`sandbox ${current.status}`);
    if (Date.now() > deadline) throw unavailable(`sandbox ${current.status}`);
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
};

/**
 * When the Orb's processes started (epoch ms): dx-orb.service's main
 * process, which systemd starts on every boot. A Lizard pause keeps files
 * only and the resume boots fresh (memory pauses are off since 2026-11-10),
 * so a Terminal shell that was ready before it died with the pause.
 */
const ORB_STARTED_AT =
  'for _ in $(seq 1 30); do pid=$(systemctl show -p MainPID --value dx-orb.service); test "$pid" -gt 0 2>/dev/null && break; sleep 1; done; test "$pid" -gt 0 2>/dev/null && echo $(( $(date +%s) - $(ps -o etimes= -p "$pid") ))';

const orbStartedAt = async (api: LizardApi, id: string) => {
  const result = await api
    .exec(id, ORB_STARTED_AT, { timeoutMs: 60_000 })
    .catch(() => undefined);
  const seconds = Number(result?.stdout.trim());
  return result?.exitCode === 0 && Number.isSafeInteger(seconds) && seconds > 0
    ? seconds * 1_000
    : undefined;
};

const handleFor = async (
  api: LizardApi,
  db: D1Database,
  threadId: string,
  sandboxId: string,
  idleMs: number,
): Promise<DaemonGuestHandle> => {
  const client = lizardGuestClient(api, sandboxId);
  const processesStartedAt = await orbStartedAt(api, sandboxId);
  return {
    guest: orbGuest(client),
    sandbox: async (cwd) => orbGuestSandbox(client, cwd),
    // Lizard has no idle pause, and its timeout deletes the sandbox, so
    // Core pauses it at this deadline (idle-deadlines.ts).
    setIdleDeadline: (durationMs) =>
      setIdleDeadline(
        db,
        { providerId: LIZARD, sandboxId, threadId },
        durationMs,
      ),
    inactivityMs: idleMs,
    ...(processesStartedAt === undefined ? {} : { processesStartedAt }),
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  };
};

const createSandbox = async (
  api: LizardApi,
  profile: LizardRunnerProfileConfiguration,
  threadId: string,
) => {
  if (profile.snapshot === undefined)
    throw unavailable("no prepared Orb snapshot");
  const created = await api.createSandbox({
    size: profile.size,
    snapshotId: profile.snapshot,
    metadata: { dxThread: threadId },
  });
  return untilRunning(api, created.id);
};

/**
 * Creates (on the first activation) or reconnects to the Thread's sandbox.
 * The D1 record pins the provider and the sandbox ID; the sandbox keeps its
 * size and disk, and a pause keeps its memory.
 */
const openLizardWorkspace = async (
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
  const profile = lizardProfile(context.profile);
  const api = apiFor(context, send);
  const idleMs =
    context.inactivityMs === undefined
      ? await inactivityMs(bindings)
      : Math.min(
          MAX_INACTIVITY_MS,
          Math.max(MIN_INACTIVITY_MS, context.inactivityMs),
        );
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const records = executionWorkspaceRecords(db, LIZARD);
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
    if (record.provider !== LIZARD) throw unavailable("other provider");
    if (record.state === "provisioning") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      const sandbox = await createSandbox(api, profile, id);
      if (!(await records.initialize(id, record, sandbox.id))) {
        await api.kill(sandbox.id).catch(() => undefined);
        continue;
      }
      return handleFor(api, db, id, sandbox.id, idleMs);
    }
    return reconnect(api, db, records, id, record, idleMs, options);
  }
  throw unavailable("contended");
};

const reconnect = async (
  api: LizardApi,
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
  const sandboxId = record.providerSandboxId;
  const sandbox: LizardSandbox | undefined = await api.getSandbox(sandboxId);
  if (sandbox === undefined || GONE.has(sandbox.status)) {
    await records.markLost(threadId);
    await clearIdleDeadline(db, LIZARD, sandboxId);
    throw unavailable(
      sandbox === undefined ? "sandbox gone" : `sandbox ${sandbox.status}`,
    );
  }
  const paused = PAUSED.has(sandbox.status);
  await options.observeResidency?.(paused ? "paused" : "running");
  await options.authorize();
  if (paused) {
    // A pause still finishing must end before the resume.
    if (sandbox.status === "pausing") await untilPaused(api, sandboxId);
    await api.resume(sandboxId).catch((cause: unknown) => {
      // Another activation is resuming it already.
      if (!(cause instanceof LizardApiError && cause.status === 409))
        throw cause;
    });
  }
  await untilRunning(api, sandboxId);
  return handleFor(api, db, threadId, sandboxId, idleMs);
};

const untilPaused = async (api: LizardApi, id: string) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const current = await api.getSandbox(id);
    if (current === undefined || current.status !== "pausing") return;
    if (Date.now() > deadline) throw unavailable("sandbox pausing");
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
};

/**
 * Pauses an idle sandbox (the idle sweep's Lizard pauser). A sandbox that
 * is gone or already paused needs nothing.
 */
export const pauseIdleLizardSandbox = async (
  bindings: Bindings,
  sandboxId: string,
  send?: typeof fetch,
) => {
  const api = deploymentLizardApi(bindings, send);
  if (api === undefined) throw unavailable("no Lizard account");
  const sandbox = await api.getSandbox(sandboxId);
  if (sandbox === undefined || sandbox.status !== "running") return;
  await api.pause(sandboxId);
};

/**
 * Lizard sandboxes (https://lizard.build), one per Thread, on the
 * deployment's own Lizard account (a hosted offer). Every size starts from the dx
 * Orb snapshot the deployment's preparation made for it (connector.ts).
 * A pause keeps memory, so processes resume in place
 * (`execution.pause-resume`, `processes`). Lizard has no idle pause, so
 * the handle's idle deadline lives in D1 and the Worker's cron pauses the
 * sandbox there; archiving pauses it, the next activation resumes it, and
 * destroying deletes it.
 */
export const makeLizardExecutionProvider = (
  options: { readonly fetch?: typeof fetch } = {},
): ExecutionProvider<DaemonGuestHandle> => ({
  workspace: {
    create: (context, { threadId }, open) =>
      openLizardWorkspace(context, threadId, options.fetch, {
        existingOnly: false,
        authorize: open.authorize,
        ...(open.observeResidency === undefined
          ? {}
          : { observeResidency: open.observeResidency }),
      }),
    connect: (context, { threadId }, open) =>
      openLizardWorkspace(context, threadId, options.fetch, {
        existingOnly: true,
        authorize: open.authorize,
      }),
    async release(context, { threadId }, mode) {
      lizardProfile(context.profile);
      const bindings = env as Bindings;
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      const records = executionWorkspaceRecords(db, LIZARD);
      const record = await records.read(threadId);
      if (record === null) throw unavailable("no workspace record");
      if (record.state === "uninitialized") return;
      if (record.provider !== LIZARD) throw unavailable("other provider");
      if (mode === "destroy" && record.state === "lost") return;
      // Provisioning or conflict fails closed, as on E2B.
      if (record.state !== "initialized" || record.providerSandboxId === null)
        throw unavailable(record.state);
      const sandboxId = record.providerSandboxId;
      const api = apiFor(context, options.fetch);
      if (mode === "archive") {
        await assertThreadLifecycleState(db, threadId, "archived");
        const sandbox = await api.getSandbox(sandboxId);
        if (sandbox?.status === "running") await api.pause(sandboxId);
        await clearIdleDeadline(db, LIZARD, sandboxId);
        return;
      }
      await api.kill(sandboxId);
      await clearIdleDeadline(db, LIZARD, sandboxId);
      await records.markLost(threadId);
    },
  },
  residentDaemon: guestResidentDaemon(),
});

export const lizardExecutionProvider = makeLizardExecutionProvider();
