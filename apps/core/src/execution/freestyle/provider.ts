import { env } from "cloudflare:workers";
import { type FreestyleRunnerProfileConfiguration, ThreadId } from "@dx/domain";
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
  type FreestyleApi,
  FreestyleApiError,
  type FreestyleVm,
  freestyleApi,
} from "./api.js";
import { freestyleGuestClient } from "./guest.js";

const FREESTYLE = "freestyle";
const COMMAND_TIMEOUT_MS = 300_000;
const MIN_INACTIVITY_MS = 60_000;
const MAX_INACTIVITY_MS = 3_600_000;
const STATE_RETRIES = 3;
const RUNNING_TIMEOUT_MS = 120_000;
const RUNNING_POLL_MS = 1_000;

export class FreestyleWorkspaceUnavailable extends Schema.TaggedError<FreestyleWorkspaceUnavailable>()(
  "FreestyleWorkspaceUnavailable",
  { reason: Schema.String },
) {}

const unavailable = (reason: string) =>
  new FreestyleWorkspaceUnavailable({ reason });

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

const freestyleProfile = (
  profile: ExecutionContext["profile"],
): FreestyleRunnerProfileConfiguration => {
  if (profile.adapter !== FREESTYLE)
    throw unavailable("Freestyle execution requires a Freestyle profile.");
  return profile;
};

/** Freestyle runs only on a person's or workspace's own account. */
const apiFor = (context: ExecutionContext, send?: typeof fetch) => {
  const apiKey =
    context.credentials === undefined
      ? undefined
      : Redacted.value(context.credentials).apiKey;
  if (context.account.scope === "deployment" || apiKey === undefined)
    throw unavailable("no Freestyle connection");
  return freestyleApi(apiKey, send);
};

/** The VM's slug: one per Thread, so a retried create finds its VM. */
export const freestyleVmSlug = (threadId: string) =>
  threadId.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

/**
 * Freestyle pauses a VM, keeping its memory, once its total run time
 * reaches `maxRunTotalSeconds`; every later start is refused until the
 * budget is raised. Core moves that budget forward the way it moves E2B's
 * sandbox timeout: `durationMs` of run time from now.
 */
const moveRunDeadline = async (
  api: FreestyleApi,
  vm: string,
  durationMs: number,
  current?: FreestyleVm,
) => {
  const known = current ?? (await api.getVm(vm));
  if (known === undefined) throw unavailable("VM gone");
  await api.updateVm(vm, {
    maxRunTotalSeconds: Math.ceil(
      (known.totalRunSeconds ?? 0) + durationMs / 1_000,
    ),
  });
};

const untilRunning = async (api: FreestyleApi, vm: string) => {
  const deadline = Date.now() + RUNNING_TIMEOUT_MS;
  for (;;) {
    const current = await api.getVm(vm);
    if (current === undefined) throw unavailable("VM gone");
    if (current.state === "running") return current;
    if (Date.now() > deadline) throw unavailable(`VM ${current.state}`);
    await new Promise((resolve) => setTimeout(resolve, RUNNING_POLL_MS));
  }
};

/** Starts a paused or stopped VM with a fresh run budget. */
const wake = async (
  api: FreestyleApi,
  current: FreestyleVm,
  idleMs: number,
) => {
  await moveRunDeadline(api, current.id, idleMs, current);
  if (current.state === "paused" || current.state === "stopped")
    await api.startVm(current.id).catch((cause: unknown) => {
      // Another activation started it first.
      if (!(cause instanceof FreestyleApiError && cause.status === 409))
        throw cause;
    });
  return untilRunning(api, current.id);
};

const handleFor = (
  api: FreestyleApi,
  vm: string,
  idleMs: number,
): DaemonGuestHandle => {
  const client = freestyleGuestClient(api, vm);
  return {
    guest: orbGuest(client),
    sandbox: async (cwd) => orbGuestSandbox(client, cwd),
    setIdleDeadline: (durationMs) => moveRunDeadline(api, vm, durationMs),
    inactivityMs: idleMs,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  };
};

const createVm = async (
  api: FreestyleApi,
  profile: FreestyleRunnerProfileConfiguration,
  threadId: string,
  idleMs: number,
) => {
  if (profile.snapshot === undefined)
    throw unavailable("no prepared Orb snapshot");
  const slug = freestyleVmSlug(threadId);
  const created = await api
    .createVm({
      snapshotId: profile.snapshot,
      slug,
      displayName: `dx ${threadId}`,
      metadata: { dxThread: threadId },
      maxRunTotalSeconds: Math.ceil(idleMs / 1_000),
    })
    .catch(async (cause: unknown) => {
      // A create that reached Freestyle before an earlier attempt failed.
      if (cause instanceof FreestyleApiError && cause.status === 409) {
        const existing = await api.getVm(slug);
        if (existing !== undefined) return existing;
      }
      throw cause;
    });
  return untilRunning(api, created.id);
};

/**
 * Creates (on the first activation) or reconnects to the Thread's VM. The
 * D1 record pins the provider and the VM ID; the VM itself keeps its size
 * and memory. A wake is one D1 read and a few Freestyle calls.
 */
const openFreestyleWorkspace = async (
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
  const profile = freestyleProfile(context.profile);
  const api = apiFor(context, send);
  const idleMs = await inactivityMs(bindings);
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const records = executionWorkspaceRecords(db, FREESTYLE);
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
    if (record.provider !== FREESTYLE) throw unavailable("other provider");
    if (record.state === "provisioning") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      const vm = await createVm(api, profile, id, idleMs);
      if (!(await records.initialize(id, record, vm.id))) continue;
      return handleFor(api, vm.id, idleMs);
    }
    return reconnect(api, records, id, record, idleMs, options);
  }
  throw unavailable("contended");
};

const reconnect = async (
  api: FreestyleApi,
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
  const vm = await api.getVm(record.providerSandboxId);
  if (vm === undefined) {
    await records.markLost(threadId);
    throw unavailable("VM gone");
  }
  await options.observeResidency?.(
    vm.state === "running" ? "running" : "paused",
  );
  await options.authorize();
  const running = vm.state === "running" ? vm : await wake(api, vm, idleMs);
  return handleFor(api, running.id, idleMs);
};

/**
 * Freestyle VMs (https://www.freestyle.sh), one per Thread, in a person's
 * or workspace's own Freestyle account. Each size boots from the dx Orb
 * snapshot its connection prepared (connector.ts). It claims
 * `execution.pause-resume` with `preserves: "processes"`: archiving and the
 * run deadline pause the VM with its memory, and the next activation
 * resumes the same processes. Destroying deletes the VM.
 */
export const makeFreestyleExecutionProvider = (
  options: { readonly fetch?: typeof fetch } = {},
): ExecutionProvider<DaemonGuestHandle> => ({
  workspace: {
    create: (context, { threadId }, open) =>
      openFreestyleWorkspace(context, threadId, options.fetch, {
        existingOnly: false,
        authorize: open.authorize,
        ...(open.observeResidency === undefined
          ? {}
          : { observeResidency: open.observeResidency }),
      }),
    connect: (context, { threadId }, open) =>
      openFreestyleWorkspace(context, threadId, options.fetch, {
        existingOnly: true,
        authorize: open.authorize,
      }),
    async release(context, { threadId }, mode) {
      freestyleProfile(context.profile);
      const bindings = env as Bindings;
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      const records = executionWorkspaceRecords(db, FREESTYLE);
      const record = await records.read(threadId);
      if (record === null) throw unavailable("no workspace record");
      if (record.state === "uninitialized") return;
      if (record.provider !== FREESTYLE) throw unavailable("other provider");
      if (mode === "destroy" && record.state === "lost") return;
      // Provisioning or conflict fails closed, as on E2B.
      if (record.state !== "initialized" || record.providerSandboxId === null)
        throw unavailable(record.state);
      const api = apiFor(context, options.fetch);
      if (mode === "archive") {
        await assertThreadLifecycleState(db, threadId, "archived");
        await api.pauseVm(record.providerSandboxId).catch((cause: unknown) => {
          // Already paused or stopped.
          if (!(cause instanceof FreestyleApiError && cause.status === 409))
            throw cause;
        });
        return;
      }
      await api.deleteVm(record.providerSandboxId);
      await records.markLost(threadId);
    },
  },
  residentDaemon: guestResidentDaemon(),
});

export const freestyleExecutionProvider = makeFreestyleExecutionProvider();
