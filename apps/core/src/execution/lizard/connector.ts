import { LIZARD_SIZE_CATALOG, type OrbProviderCredentials } from "@dx/domain";
import {
  failedPreparation,
  type OrbPreparation,
  type OrbProviderConnector,
  OrbProviderCredentialsRejected,
} from "../../plugins/execution/connector.js";
import {
  ORB_CHECK_COMMAND,
  ORB_CHECK_TIMEOUT_SECONDS,
  orbCheckFailure,
} from "../guest/orb-check.js";
import {
  startVmOrbSetup,
  vmOrbRecipe,
  vmOrbSetupStatus,
} from "../guest/vm-orb-recipe.js";
import { type LizardApi, LizardApiError, lizardApi } from "./api.js";
import { lizardBuildGuest } from "./guest.js";

/**
 * Lizard on the deployment's own account (a hosted offer). Lizard sandboxes boot
 * its Debian 12 `claude` template, and a snapshot restores at the size it
 * was taken at. So preparing the account builds one dx Orb snapshot per
 * size in `LIZARD_SIZE_CATALOG`, side by side: a sandbox of that size runs
 * deploy/orb/install.sh, is snapshotted (memory and disk) as
 * `dx-orb-<recipe>-<size>`, and is deleted. Then a test Orb starts from
 * each size's snapshot, checks that dx-orb-init supervises dxd, runs
 * dx-orb-check (every workspace feature, the Desktop included), and is
 * deleted. A size the account cannot start (Lizard's trial starts only
 * Small; Large needs a plan above 4 vCPUs; Mini needs Lizard to enable it),
 * or whose build or check fails, is unavailable with the reason; the rest
 * are ready. Preparation fails only when no size is.
 *
 * Threads pin their size's snapshot and start from it.
 */

const STEP_MS = 2_000;
const BUILD_POLL_MS = 10_000;
/** A setup still running after this long has failed. */
const SETUP_TIMEOUT_MS = 45 * 60_000;
const PROBE_READY_MS = 180_000;
/** Steps in a row whose Lizard call failed before a size gives up. */
const MAX_FAILURES = 10;
/** A build sandbox dx loses is deleted by Lizard after this long. */
// Under an hour: Lizard's trial refuses a longer lifetime
// (TRIAL_SANDBOX_LIFETIME), and a build takes about 15 minutes.
const BUILD_DELETE_AFTER_MS = 55 * 60_000;
const PROBE_DELETE_AFTER_MS = 15 * 60_000;
/** The template every build starts from (Debian 12, systemd). */
const TEMPLATE = "claude";

type Phase =
  | "creating"
  | "setup"
  | "snapshotting"
  | "probing"
  | "ready"
  | "unavailable";

interface SizeBuild {
  readonly phase: Phase;
  readonly sandbox?: string;
  readonly snapshot?: string;
  readonly setupStartedAt?: number;
  /** Why the size is unavailable, in the account's or the build's words. */
  readonly reason?: string;
  readonly failures?: number;
}

interface LizardState {
  /** One build per Orb size ID. */
  readonly sizes: Readonly<Record<string, SizeBuild>>;
}

type Fetch = typeof fetch;

/** The snapshot one size's build makes. */
export const lizardSnapshotName = (recipe: string, size: string) =>
  `dx-orb-${recipe}-${size}`;

const REJECTED = "Lizard rejected this API key.";
const NO_PROJECT =
  "Set LIZARD_PROJECT_ID to the Lizard project dx's Orbs run in.";

const credentialsOf = (credentials: OrbProviderCredentials) => {
  const { apiKey, projectId, region } = credentials;
  if (apiKey === undefined)
    throw new OrbProviderCredentialsRejected("Enter a Lizard API key.");
  if (projectId === undefined)
    throw new OrbProviderCredentialsRejected(NO_PROJECT);
  return { apiKey, projectId, region };
};

const apiFor = (credentials: OrbProviderCredentials, send: Fetch) => {
  const { apiKey, projectId, region } = credentialsOf(credentials);
  return lizardApi(apiKey, projectId, send, region);
};

const rejected = (cause: unknown) =>
  cause instanceof LizardApiError && cause.status === 401;

/**
 * Lizard's refusal of a size the account cannot start (its plan, its trial,
 * or a size it has not enabled), in Lizard's own words.
 */
/**
 * Lizard's codes for a size the account cannot start at all (lizard.build
 * /docs/platform/limits): its plan's largest size, the trial's sizes, or the
 * trial's regions. Too many running (TRIAL_SIZE_RUNNING, or 429
 * SANDBOX_LIMIT_REACHED and SANDBOX_RATE_LIMITED) is not one: that step is
 * retried.
 */
const SIZE_REFUSALS = new Set([
  "SANDBOX_SIZE_NOT_ALLOWED",
  "TRIAL_SANDBOX_SIZE",
  "TRIAL_SANDBOX_REGION",
]);

const refusedSize = (cause: unknown) =>
  cause instanceof LizardApiError &&
  (cause.status === 402 ||
    (cause.code !== undefined && SIZE_REFUSALS.has(cause.code)))
    ? `Lizard refused this size: ${cause.message}`
    : undefined;

class SizeFailed extends Error {}

const stateOf = (preparation: Pick<OrbPreparation, "state">): LizardState =>
  typeof preparation.state.sizes === "object" && preparation.state.sizes
    ? (preparation.state as unknown as LizardState)
    : { sizes: {} };

const settled = (build: SizeBuild) =>
  build.phase === "ready" || build.phase === "unavailable";

const preparing = (
  account: string,
  state: LizardState,
  nextStepInMs: number,
): OrbPreparation => {
  const builds = Object.values(state.sizes);
  return {
    status: "preparing",
    account,
    state: state as unknown as OrbPreparation["state"],
    progress: {
      step: builds.some(({ phase }) => phase === "probing")
        ? "Starting test Orbs"
        : "Building the Orb in each size",
      done: builds.filter(settled).length,
      total: builds.length,
    },
    error: null,
    nextStepInMs,
  };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a sandbox from `snapshot`, checks the Orb inside, deletes it. */
const probe = async (api: LizardApi, snapshot: string) => {
  const sandbox = await api.createSandbox({
    size: "medium",
    snapshotId: snapshot,
    metadata: { dxOrbProbe: "1" },
    deleteAfterMs: PROBE_DELETE_AFTER_MS,
  });
  try {
    const deadline = Date.now() + PROBE_READY_MS;
    for (;;) {
      const current = await api.getSandbox(sandbox.id);
      if (current?.status === "running") break;
      if (
        current === undefined ||
        current.status === "crashed" ||
        current.status === "stopped" ||
        Date.now() > deadline
      )
        throw new SizeFailed("The test Orb did not start.");
      await delay(1_000);
    }
    // The restored Orb keeps the build's running services; dx-orb-init
    // supervises dxd as the workspace account.
    const ran = await api.exec(
      sandbox.id,
      'true && for _ in $(seq 1 60); do if systemctl is-active --quiet dx-orb.service && test -f /home/user/.local/state/dxd/supervisor.pid && kill -0 "$(cat /home/user/.local/state/dxd/supervisor.pid)"; then exit 0; fi; sleep 1; done; exit 1',
      { timeoutMs: 90_000 },
    );
    if (ran.exitCode !== 0)
      throw new SizeFailed("The test Orb did not start dx-orb-init.");
    // Every workspace feature, the Desktop included (dx-orb-check), which
    // becomes the workspace account itself (`sudo -u user`).
    const checked = await api.exec(sandbox.id, ORB_CHECK_COMMAND, {
      timeoutMs: ORB_CHECK_TIMEOUT_SECONDS * 1_000,
    });
    const failure = orbCheckFailure(checked.stdout, checked.exitCode);
    if (failure !== undefined) {
      // dx-orb-check's own FAIL lines say why, for the unavailable size.
      const why = checked.stdout
        .split("\n")
        .filter((line) => line.startsWith("FAIL"))
        .join("; ")
        .slice(0, 400);
      throw new SizeFailed(why === "" ? failure : `${failure} ${why}`);
    }
  } finally {
    await api.kill(sandbox.id).catch(() => undefined);
  }
};

/** One step of one size's build; returns its next state. */
const advanceSize = async (
  api: LizardApi,
  recipe: string,
  sizeId: string,
  build: SizeBuild,
): Promise<SizeBuild> => {
  const size = LIZARD_SIZE_CATALOG.find(({ id }) => id === sizeId);
  if (size === undefined)
    return { phase: "unavailable", reason: "dx no longer offers this size." };
  switch (build.phase) {
    case "creating": {
      const created = await api
        .createSandbox({
          size: size.size,
          template: TEMPLATE,
          metadata: { dxOrbBuild: recipe },
          deleteAfterMs: BUILD_DELETE_AFTER_MS,
        })
        .catch((cause: unknown) => {
          const refused = refusedSize(cause);
          if (refused !== undefined) return { refused };
          throw cause;
        });
      if ("refused" in created)
        return { phase: "unavailable", reason: created.refused };
      await startVmOrbSetup(lizardBuildGuest(api, created.id));
      return {
        phase: "setup",
        sandbox: created.id,
        setupStartedAt: Date.now(),
      };
    }
    case "setup": {
      const sandbox = build.sandbox as string;
      // Taking a snapshot of a full VM can outlast the request, and the VM
      // answers commands oddly while Lizard takes it. A step that lost its
      // answer finds the snapshot it started by name before anything else,
      // so it never reads the setup mid-snapshot or takes a second one.
      const name = lizardSnapshotName(recipe, size.size);
      const started = (await api.snapshots()).find(
        (snapshot) =>
          snapshot.name === name &&
          snapshot.status !== "failed" &&
          // Only one this build took: an older one may be of an earlier build.
          (snapshot.createdAt ?? 0) >= (build.setupStartedAt ?? 0),
      );
      if (started !== undefined)
        return { ...build, phase: "snapshotting", snapshot: started.id };
      const status = await vmOrbSetupStatus(lizardBuildGuest(api, sandbox));
      if (status.state === "running") {
        if (Date.now() - (build.setupStartedAt ?? 0) < SETUP_TIMEOUT_MS)
          return build;
        throw new SizeFailed("The Orb setup did not finish in 45 minutes.");
      }
      if (status.state === "failed")
        throw new SizeFailed(
          `The Orb setup failed${status.log === "" ? "" : `: ${status.log}`}`,
        );
      const snapshot = await api.snapshot(sandbox, name);
      return { ...build, phase: "snapshotting", snapshot: snapshot.id };
    }
    case "snapshotting": {
      const snapshot = await api.getSnapshot(build.snapshot as string);
      if (snapshot === undefined)
        throw new Error("Lizard lost the Orb snapshot it was taking.");
      if (snapshot.status === "failed")
        throw new SizeFailed(
          `Lizard could not snapshot the Orb${snapshot.error ? `: ${snapshot.error}` : ""}`,
        );
      if (snapshot.status !== "ready") return build;
      await api.kill(build.sandbox as string).catch(() => undefined);
      return { phase: "probing", snapshot: build.snapshot as string };
    }
    case "probing":
      await probe(api, build.snapshot as string);
      return { phase: "ready", snapshot: build.snapshot as string };
    case "ready":
    case "unavailable":
      return build;
  }
};

/** Snapshots of earlier recipes are deleted once this old. */
const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1_000;

/**
 * Deletes this recipe's snapshots that no size kept (a duplicate a lost
 * answer left), and earlier recipes' once a day old, so Threads still
 * starting from the version before keep it meanwhile.
 */
const deleteOtherSnapshots = async (
  api: LizardApi,
  recipe: string,
  kept: ReadonlySet<string>,
) => {
  const listed = await api.snapshots().catch(() => []);
  for (const { id, name, createdAt } of listed) {
    if (name === undefined || kept.has(id)) continue;
    const ours = name.startsWith(`dx-orb-${recipe}-`);
    const earlier =
      /^dx-orb-[0-9a-f]{16}-/.test(name) &&
      !ours &&
      createdAt !== undefined &&
      Date.now() - createdAt >= STALE_SNAPSHOT_MS;
    if (ours || earlier) await api.deleteSnapshot(id).catch(() => undefined);
  }
};

/** A size that failed: its build sandbox and snapshot go, with the reason. */
const giveUp = async (
  api: LizardApi,
  build: SizeBuild,
  reason: string,
): Promise<SizeBuild> => {
  if (build.sandbox !== undefined)
    await api.kill(build.sandbox).catch(() => undefined);
  if (build.snapshot !== undefined)
    await api.deleteSnapshot(build.snapshot).catch(() => undefined);
  return { phase: "unavailable", reason };
};

export const makeLizardConnector = (
  options: { readonly fetch?: Fetch } = {},
): OrbProviderConnector => {
  const send: Fetch = (...args) => (options.fetch ?? fetch)(...args);
  let recipe: Promise<string> | undefined;
  return {
    providerId: "lizard",
    description:
      "Runs Orbs as Lizard sandboxes on this deployment's own account.",
    // Deployment-only: people never fill in a form for it.
    fields: [],
    recipe: () => {
      recipe ??= vmOrbRecipe(
        `lizard\0${TEMPLATE}\0${JSON.stringify(LIZARD_SIZE_CATALOG.map(({ id, size }) => [id, size]))}`,
      );
      return recipe;
    },
    async start(credentials, _recipe) {
      const { projectId } = credentialsOf(credentials);
      await apiFor(credentials, send)
        .limits()
        .catch((cause: unknown) => {
          if (rejected(cause))
            throw new OrbProviderCredentialsRejected(REJECTED);
          if (cause instanceof LizardApiError && cause.status === 404)
            throw new OrbProviderCredentialsRejected(NO_PROJECT);
          throw cause;
        });
      return preparing(
        projectId,
        {
          sizes: Object.fromEntries(
            LIZARD_SIZE_CATALOG.map(({ id }) => [id, { phase: "creating" }]),
          ),
        },
        STEP_MS,
      );
    },
    async advance(credentials, recipe, current) {
      const api = apiFor(credentials, send);
      const account = current.account ?? "";
      const state = stateOf(current);
      const next = Object.fromEntries(
        (await Promise.all(
          Object.entries(state.sizes).map(async ([sizeId, build]) => {
            if (settled(build)) return [sizeId, build] as const;
            try {
              const { failures: _, ...advanced } = await advanceSize(
                api,
                recipe,
                sizeId,
                build,
              );
              return [sizeId, advanced] as const;
            } catch (cause) {
              if (rejected(cause)) throw cause;
              if (cause instanceof SizeFailed)
                return [sizeId, await giveUp(api, build, cause.message)];
              const failures = (build.failures ?? 0) + 1;
              if (failures >= MAX_FAILURES)
                return [
                  sizeId,
                  await giveUp(
                    api,
                    build,
                    `Lizard kept failing while building the Orb: ${cause instanceof Error ? cause.message : "unknown error"}`,
                  ),
                ] as const;
              return [sizeId, { ...build, failures }] as const;
            }
          }),
        ).catch((cause: unknown) => {
          if (rejected(cause)) return undefined;
          throw cause;
        })) ?? [],
      ) as Record<string, SizeBuild>;
      if (Object.keys(next).length === 0)
        return failedPreparation(current, REJECTED);
      const builds = Object.values(next);
      if (!builds.every(settled))
        return preparing(
          account,
          { sizes: next },
          builds.some(({ phase }) => phase === "setup")
            ? BUILD_POLL_MS
            : STEP_MS,
        );
      // Every size settled: only the ready sizes' snapshots stay, whether
      // or not any is ready.
      await deleteOtherSnapshots(
        api,
        recipe,
        new Set(
          builds.flatMap(({ phase, snapshot }) =>
            phase === "ready" && snapshot !== undefined ? [snapshot] : [],
          ),
        ),
      );
      if (!builds.some(({ phase }) => phase === "ready"))
        return failedPreparation(
          current,
          `No Orb size could run on this Lizard account. ${[
            ...new Set(builds.map(({ reason }) => reason).filter(Boolean)),
          ].join(" ")}`.trim(),
        );
      return {
        status: "ready",
        account,
        state: { sizes: next } as unknown as OrbPreparation["state"],
        progress: null,
        error: null,
      };
    },
    targets: (preparation) => {
      if (preparation.status !== "ready") return undefined;
      return new Map(
        Object.entries(stateOf(preparation).sizes).flatMap(([size, build]) =>
          build.phase === "ready" && build.snapshot !== undefined
            ? [[size, build.snapshot] as const]
            : [],
        ),
      );
    },
    // A size the account cannot start has no target; a plan upgrade adds
    // it when Core prepares the account again.
    unavailable: (preparation) =>
      preparation.status !== "ready"
        ? undefined
        : new Map(
            Object.entries(stateOf(preparation).sizes).flatMap(
              ([size, build]) =>
                build.phase === "unavailable"
                  ? [[size, build.reason ?? "Unavailable."] as const]
                  : [],
            ),
          ),
  };
};
