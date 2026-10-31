import { env } from "cloudflare:workers";
import { type BoatRunnerProfileConfiguration, ThreadId } from "@dx/domain";
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
  type BoatApi,
  BoatApiError,
  type BoatSandbox,
  type BoatSandboxState,
  boatApi,
} from "./api.js";
import { boatGuestClient } from "./guest.js";

const BOAT = "boat";
const COMMAND_TIMEOUT_MS = 300_000;
const MIN_INACTIVITY_MS = 60_000;
const MAX_INACTIVITY_MS = 3_600_000;
const STATE_RETRIES = 3;
/** A create or resume waits this long for a machine and the disk. */
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 1_000;
const RESUME_SETTLE_MS = 30_000;

const READY: ReadonlySet<BoatSandboxState> = new Set([
  "ready",
  "idle",
  "running",
]);
const STARTING: ReadonlySet<BoatSandboxState> = new Set([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
]);
/** States a resume brings back: stopped, stopping, or failed. */
const RESUMABLE: ReadonlySet<BoatSandboxState> = new Set([
  "archiving",
  "archived",
  "error",
]);

export class BoatWorkspaceUnavailable extends Schema.TaggedError<BoatWorkspaceUnavailable>()(
  "BoatWorkspaceUnavailable",
  { reason: Schema.String },
) {}

const unavailable = (reason: string) =>
  new BoatWorkspaceUnavailable({ reason });

/** Boat deleted the disk 14 days after the sandbox stopped. */
const EXPIRED = "Boat deleted this Orb's disk 14 days after it stopped";

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

const boatProfile = (
  profile: ExecutionContext["profile"],
): BoatRunnerProfileConfiguration => {
  if (profile.adapter !== BOAT)
    throw unavailable("Boat execution requires a Boat profile.");
  return profile;
};

/** Boat runs only on a person's or workspace's own account. */
const apiFor = (context: ExecutionContext, send?: typeof fetch) => {
  const apiKey =
    context.credentials === undefined
      ? undefined
      : Redacted.value(context.credentials).apiKey;
  if (context.account.scope === "deployment" || apiKey === undefined)
    throw unavailable("no Boat connection");
  return boatApi(apiKey, send);
};

/** Boat's auto-stop: at most 30 days, and the deadline is now + TTL. */
const ttlSeconds = (durationMs: number) =>
  Math.min(2_592_000, Math.max(1, Math.ceil(durationMs / 1_000)));

const gone = (sandbox: BoatSandbox | undefined) =>
  sandbox === undefined ||
  sandbox.state === "cancelled" ||
  (sandbox.dataExpiredAt ?? null) !== null;

/**
 * Polls until the sandbox runs commands. Right after a resume, Boat may
 * still report the stop for a moment.
 */
const untilReady = async (api: BoatApi, id: string, resumed = false) => {
  const started = Date.now();
  const deadline = started + READY_TIMEOUT_MS;
  for (;;) {
    const current = await api.getSandbox(id);
    if (current === undefined) throw unavailable("sandbox gone");
    if (READY.has(current.state)) return current;
    const stopping =
      current.state === "archiving" || current.state === "archived";
    if (
      !STARTING.has(current.state) &&
      !(resumed && stopping && Date.now() - started < RESUME_SETTLE_MS)
    )
      throw unavailable(`sandbox ${current.state}`);
    if (Date.now() > deadline) throw unavailable(`sandbox ${current.state}`);
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
};

/**
 * When the Orb's processes started (epoch ms): dx-orb.service's main
 * process, which systemd starts on every boot and resume. A stop ends every
 * process, so a Terminal shell that was ready before this died with the
 * Orb. Not /proc/stat's boot time: Boat runs a resumed sandbox on a pooled
 * machine that booted long before (seen 2026-10-31). The service starts a
 * few seconds after Boat reports the sandbox ready.
 */
const ORB_STARTED_AT =
  'for _ in $(seq 1 30); do pid=$(systemctl show -p MainPID --value dx-orb.service); test "$pid" -gt 0 2>/dev/null && break; sleep 1; done; test "$pid" -gt 0 2>/dev/null && echo $(( $(date +%s) - $(ps -o etimes= -p "$pid") ))';

const orbStartedAt = async (api: BoatApi, id: string) => {
  const result = await api
    .command(id, ORB_STARTED_AT, 60)
    .catch(() => undefined);
  const seconds = Number(result?.stdout.trim());
  return result?.exitCode === 0 && Number.isSafeInteger(seconds) && seconds > 0
    ? seconds * 1_000
    : undefined;
};

const handleFor = async (
  api: BoatApi,
  id: string,
  idleMs: number,
): Promise<DaemonGuestHandle> => {
  const client = boatGuestClient(api, id);
  const processesStartedAt = await orbStartedAt(api, id);
  return {
    guest: orbGuest(client),
    sandbox: async (cwd) => orbGuestSandbox(client, cwd),
    // Boat's own auto-stop is the idle pause: dxd's connection never makes
    // a sandbox idle, and nothing in Core stops it.
    setIdleDeadline: (durationMs) => api.setTtl(id, ttlSeconds(durationMs)),
    inactivityMs: idleMs,
    ...(processesStartedAt === undefined ? {} : { processesStartedAt }),
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  };
};

const createSandbox = async (
  api: BoatApi,
  profile: BoatRunnerProfileConfiguration,
  threadId: string,
  idleMs: number,
) => {
  if (profile.snapshot === undefined)
    throw unavailable("no prepared Orb snapshot");
  const created = await api.createSandbox({
    type: profile.machineType,
    from: profile.snapshot,
    name: `dx ${threadId}`,
    ttlSeconds: ttlSeconds(idleMs),
    // A retried create returns the sandbox the first attempt made.
    idempotencyKey: `dx-${threadId}`,
  });
  return untilReady(api, created.id);
};

/**
 * Creates (on the first activation) or reconnects to the Thread's
 * sandbox. The D1 record pins the provider and the sandbox ID; the sandbox
 * keeps its size and disk. A wake is one D1 read, a resume, and a few
 * polls.
 */
const openBoatWorkspace = async (
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
  const profile = boatProfile(context.profile);
  const api = apiFor(context, send);
  const idleMs = await inactivityMs(bindings);
  const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
  const records = executionWorkspaceRecords(db, BOAT);
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
    if (record.provider !== BOAT) throw unavailable("other provider");
    if (record.state === "provisioning") {
      if (options.existingOnly) throw unavailable("not created");
      await options.authorize();
      const sandbox = await createSandbox(api, profile, id, idleMs);
      if (!(await records.initialize(id, record, sandbox.id))) continue;
      return handleFor(api, sandbox.id, idleMs);
    }
    return reconnect(api, records, id, record, idleMs, options);
  }
  throw unavailable("contended");
};

const reconnect = async (
  api: BoatApi,
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
  const sandbox = await api.getSandbox(sandboxId);
  if (gone(sandbox)) {
    await records.markLost(threadId);
    throw unavailable(sandbox === undefined ? "sandbox gone" : EXPIRED);
  }
  const current = sandbox as BoatSandbox;
  await options.observeResidency?.(
    RESUMABLE.has(current.state) ? "paused" : "running",
  );
  await options.authorize();
  if (RESUMABLE.has(current.state))
    await api
      .resumeSandbox(sandboxId, ttlSeconds(idleMs))
      .catch(async (cause: unknown) => {
        if (!(cause instanceof BoatApiError && cause.status === 409))
          throw cause;
        if (cause.code === "snapshot_data_expired") {
          await records.markLost(threadId);
          throw unavailable(EXPIRED);
        }
        // Another activation is resuming it already.
        if (cause.code !== "sandbox_resuming") throw cause;
      });
  await untilReady(api, sandboxId, RESUMABLE.has(current.state));
  return handleFor(api, sandboxId, idleMs);
};

/**
 * Boat sandboxes (https://boat.dev), one per Thread, in a person's or
 * workspace's own Boat account. Every size starts from the dx Orb saved
 * snapshot its connection prepared (connector.ts). Boat has no pause, so
 * it claims `execution.pause-resume` with `preserves: "filesystem"`:
 * archiving and the idle deadline stop the sandbox (Boat keeps its disk for
 * 14 days), and the next activation resumes it on a new machine, where
 * systemd starts the Orb's dx-orb-init again. Destroying deletes it.
 */
export const makeBoatExecutionProvider = (
  options: { readonly fetch?: typeof fetch } = {},
): ExecutionProvider<DaemonGuestHandle> => ({
  workspace: {
    create: (context, { threadId }, open) =>
      openBoatWorkspace(context, threadId, options.fetch, {
        existingOnly: false,
        authorize: open.authorize,
        ...(open.observeResidency === undefined
          ? {}
          : { observeResidency: open.observeResidency }),
      }),
    connect: (context, { threadId }, open) =>
      openBoatWorkspace(context, threadId, options.fetch, {
        existingOnly: true,
        authorize: open.authorize,
      }),
    async release(context, { threadId }, mode) {
      boatProfile(context.profile);
      const bindings = env as Bindings;
      const db = await Effect.runPromise(decodeD1Binding(bindings.DB));
      const records = executionWorkspaceRecords(db, BOAT);
      const record = await records.read(threadId);
      if (record === null) throw unavailable("no workspace record");
      if (record.state === "uninitialized") return;
      if (record.provider !== BOAT) throw unavailable("other provider");
      if (mode === "destroy" && record.state === "lost") return;
      // Provisioning or conflict fails closed, as on E2B.
      if (record.state !== "initialized" || record.providerSandboxId === null)
        throw unavailable(record.state);
      const api = apiFor(context, options.fetch);
      if (mode === "archive") {
        await assertThreadLifecycleState(db, threadId, "archived");
        await api
          .stopSandbox(record.providerSandboxId)
          .catch((cause: unknown) => {
            // Already stopped (Boat answers `400 stop_failed`), stopping,
            // or gone.
            if (
              !(
                cause instanceof BoatApiError &&
                (cause.status === 409 ||
                  cause.status === 404 ||
                  (cause.status === 400 &&
                    cause.code === "stop_failed" &&
                    /archived/.test(cause.message)))
              )
            )
              throw cause;
          });
        return;
      }
      await api.deleteSandbox(record.providerSandboxId);
      await records.markLost(threadId);
    },
  },
  residentDaemon: guestResidentDaemon(),
});

export const boatExecutionProvider = makeBoatExecutionProvider();
