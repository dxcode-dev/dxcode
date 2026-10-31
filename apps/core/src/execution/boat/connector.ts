import { BOAT_ORB_SIZES, type OrbProviderCredentials } from "@dx/domain";
import {
  failedPreparation,
  type OrbPreparation,
  type OrbProviderConnector,
  OrbProviderCredentialsRejected,
} from "../../plugins/execution/connector.js";
import {
  startVmOrbSetup,
  vmOrbRecipe,
  vmOrbSetupStatus,
} from "../guest/vm-orb-recipe.js";
import { type BoatApi, BoatApiError, boatApi } from "./api.js";
import { boatBuildGuest } from "./guest.js";

/**
 * Boat in a person's or workspace's own account
 * (tasks/orb-provider-connections.md). Every Boat sandbox boots Boat's own
 * Ubuntu 24.04 image; Boat builds no custom images, but a saved snapshot
 * of a sandbox's disk starts new sandboxes of any size. So preparing an
 * account starts one sandbox with none of the account's secrets, runs
 * deploy/orb/vm-setup.sh in it, saves its disk as the saved snapshot
 * `dx-orb-<recipe>`, and deletes it. Then a test Orb starts from that
 * snapshot, checks that systemd started dx-orb-init, and is deleted.
 *
 * Threads of every size pin that snapshot. Boat's free trial cannot save
 * snapshots, and an account with zero data retention erases a sandbox's
 * disk when it stops, so neither can connect.
 */

const STEP_MS = 2_000;
const BUILD_POLL_MS = 10_000;
/** The build sandbox stops by itself after this long if dx loses it. */
const BUILD_TTL_SECONDS = 2 * 60 * 60;
/** A setup still running after this long has failed. */
const SETUP_TIMEOUT_MS = 45 * 60_000;
const PROBE_TTL_SECONDS = 15 * 60;
const PROBE_READY_MS = 180_000;
/** Saved snapshots of earlier recipes are deleted once this old. */
const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1_000;
/** Steps in a row whose Boat call failed before preparation fails. */
const MAX_FAILURES = 10;

type Phase = "creating" | "starting" | "setup" | "saving" | "probing";

interface BoatState {
  readonly phase: Phase;
  readonly buildSandbox?: string;
  readonly setupStartedAt?: number;
  readonly failures?: number;
  /** Once ready: the saved snapshot Threads pin, and the sizes they may use. */
  readonly snapshot?: string;
  readonly sizes?: ReadonlyArray<string>;
  /** Sizes the plan refuses, each with the reason the picker shows. */
  readonly unavailable?: Readonly<Record<string, string>>;
}

type Fetch = typeof fetch;

/** The one saved snapshot this recipe makes; every size starts from it. */
export const boatSnapshotName = (recipe: string) => `dx-orb-${recipe}`;

const apiKeyOf = (credentials: OrbProviderCredentials) => {
  const apiKey = credentials.apiKey;
  if (apiKey === undefined)
    throw new OrbProviderCredentialsRejected("Enter a Boat API key.");
  return apiKey;
};

const REJECTED = "Boat rejected this API key.";
const TRIAL =
  "Boat's free trial cannot save snapshots, which dx needs for its Orb. End the trial in Boat's dashboard (Billing, Upgrade now), then save the connection again.";
const ZERO_DATA_RETENTION =
  "This Boat account has zero data retention, which erases an Orb's disk whenever it stops. Turn it off in Boat's dashboard (Account, Data & privacy) to connect.";

const rejected = (cause: unknown) =>
  cause instanceof BoatApiError && cause.status === 401;

/** What Boat's plan or balance refuses, said in its own words. */
const refusedByPlan = (cause: unknown) =>
  cause instanceof BoatApiError &&
  (cause.status === 402 ||
    cause.status === 403 ||
    cause.code === "trial_compute_limit_reached")
    ? cause.code === "trial_saved_snapshots_not_allowed"
      ? TRIAL
      : `Boat refused: ${cause.message}`
    : undefined;

class BuildFailed extends Error {}

const stateOf = (preparation: Pick<OrbPreparation, "state">): BoatState =>
  typeof preparation.state.phase === "string"
    ? (preparation.state as unknown as BoatState)
    : { phase: "creating" };

const preparing = (
  account: string,
  state: BoatState,
  nextStepInMs = STEP_MS,
): OrbPreparation => ({
  status: "preparing",
  account,
  state: state as unknown as OrbPreparation["state"],
  progress: {
    step:
      state.phase === "probing"
        ? "Starting a test Orb"
        : "Building the Orb in your Boat account",
    done: state.phase === "probing" ? 1 : 0,
    total: 2,
  },
  error: null,
  nextStepInMs,
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One step of the build; returns the next state. */
const advanceBuild = async (
  api: BoatApi,
  recipe: string,
  state: BoatState,
): Promise<BoatState> => {
  switch (state.phase) {
    case "creating": {
      const sandbox = await api.createSandbox({
        type: "small",
        name: `dx-orb-build-${recipe}`,
        ttlSeconds: BUILD_TTL_SECONDS,
      });
      return { phase: "starting", buildSandbox: sandbox.id };
    }
    case "starting": {
      const sandbox = await api.getSandbox(state.buildSandbox as string);
      if (
        sandbox === undefined ||
        sandbox.state === "cancelled" ||
        sandbox.state === "error"
      ) {
        if (sandbox !== undefined)
          await api.deleteSandbox(sandbox.id).catch(() => undefined);
        return { phase: "creating" };
      }
      if (!["ready", "idle", "running"].includes(sandbox.state)) return state;
      await startVmOrbSetup(boatBuildGuest(api, sandbox.id));
      return { ...state, phase: "setup", setupStartedAt: Date.now() };
    }
    case "setup": {
      const sandbox = state.buildSandbox as string;
      const status = await vmOrbSetupStatus(boatBuildGuest(api, sandbox));
      if (status.state === "running") {
        if (Date.now() - (state.setupStartedAt ?? 0) < SETUP_TIMEOUT_MS)
          return state;
        throw new BuildFailed("The Orb setup did not finish in 45 minutes.");
      }
      if (status.state === "failed")
        throw new BuildFailed(
          `The Orb setup failed${status.log === "" ? "" : `: ${status.log}`}`,
        );
      await api.saveSnapshot(sandbox, boatSnapshotName(recipe));
      return { ...state, phase: "saving" };
    }
    case "saving": {
      const saved = await api.savedSnapshot(boatSnapshotName(recipe));
      if (saved?.status === "failed")
        throw new BuildFailed(
          `Boat could not save the Orb snapshot${saved.error === undefined ? "" : `: ${saved.error}`}`,
        );
      // A save Boat lost counts as a failed step, so it cannot wait forever.
      if (saved === undefined)
        throw new Error("Boat lost the Orb snapshot it was saving.");
      if (saved.status !== "ready") return state;
      await api.deleteSandbox(state.buildSandbox as string);
      return { phase: "probing" };
    }
    case "probing":
      return state;
  }
};

/** Starts a sandbox from the snapshot, checks the Orb inside, deletes it. */
const probe = async (api: BoatApi, snapshot: string) => {
  const sandbox = await api.createSandbox({
    type: "small",
    from: snapshot,
    name: "dx-orb-probe",
    ttlSeconds: PROBE_TTL_SECONDS,
  });
  try {
    const deadline = Date.now() + PROBE_READY_MS;
    for (;;) {
      const current = await api.getSandbox(sandbox.id);
      if (
        current !== undefined &&
        ["ready", "idle", "running"].includes(current.state)
      )
        break;
      if (
        current === undefined ||
        current.state === "error" ||
        current.state === "cancelled" ||
        Date.now() > deadline
      )
        throw new BuildFailed("The test Orb did not start.");
      await delay(1_000);
    }
    // Enabled services start a few seconds after `ready` on a restore.
    const ran = await api.command(
      sandbox.id,
      'true && for _ in $(seq 1 60); do if systemctl is-active --quiet dx-orb.service && test -f /home/user/.local/state/dxd/supervisor.pid && kill -0 "$(cat /home/user/.local/state/dxd/supervisor.pid)"; then exit 0; fi; sleep 1; done; exit 1',
      90,
    );
    if (ran.exitCode !== 0)
      throw new BuildFailed("The test Orb did not start dx-orb-init.");
  } finally {
    await api.deleteSandbox(sandbox.id).catch(() => undefined);
  }
};

/** Deletes Orb snapshots an earlier recipe saved, once they are old. */
const deleteStaleSnapshots = async (api: BoatApi, recipe: string) => {
  const listed = await api.savedSnapshots().catch(() => []);
  for (const { name, createdAt } of listed) {
    const created = Date.parse(createdAt ?? "");
    if (
      /^dx-orb-[0-9a-f]{16}$/.test(name) &&
      name !== boatSnapshotName(recipe) &&
      Number.isFinite(created) &&
      Date.now() - created >= STALE_SNAPSHOT_MS
    )
      await api.deleteSavedSnapshot(name).catch(() => undefined);
  }
};

/**
 * The sizes whose Boat type the account can create now, and the reason for
 * each one its plan refuses (`xlarge` needs Boat's $100 plan).
 */
const planSizes = async (api: BoatApi) => {
  const { machineTypes, refusedTypes } = await api.limits();
  const allowed = ({ machineType }: (typeof BOAT_ORB_SIZES)[number]) =>
    machineTypes.length === 0 || machineTypes.includes(machineType);
  return {
    sizes: BOAT_ORB_SIZES.filter(allowed).map(({ id }) => id),
    unavailable: Object.fromEntries(
      BOAT_ORB_SIZES.filter((size) => !allowed(size)).map(
        ({ id, machineType }) => {
          const reason = refusedTypes.get(machineType);
          return [
            id,
            `Your Boat plan does not include this size${reason === undefined ? "" : ` (Boat: ${reason})`}.`,
          ] as const;
        },
      ),
    ),
  };
};

export const makeBoatConnector = (
  options: { readonly fetch?: Fetch } = {},
): OrbProviderConnector => {
  const send: Fetch = (...args) => (options.fetch ?? fetch)(...args);
  let recipe: Promise<string> | undefined;
  return {
    providerId: "boat",
    description:
      "Runs Orbs as Boat sandboxes in your own account, on a paid Boat plan. dx saves its Orb snapshot there first, which takes about ten minutes.",
    fields: [
      {
        id: "apiKey",
        label: "Boat API key",
        secret: true,
        help: "Create one in the Boat dashboard (boat.dev) under API keys, or run `boat api-key create dx --preset ci`.",
      },
    ],
    recipe: () => {
      recipe ??= vmOrbRecipe(`boat\0${JSON.stringify(BOAT_ORB_SIZES)}`);
      return recipe;
    },
    async start(credentials, recipe) {
      const api = boatApi(apiKeyOf(credentials), send);
      const account = await api.account().catch((cause: unknown) => {
        if (rejected(cause)) throw new OrbProviderCredentialsRejected(REJECTED);
        // A scoped key without `account.read`, or a suspended account.
        if (cause instanceof BoatApiError && cause.status === 403)
          throw new OrbProviderCredentialsRejected(
            `Boat refused this API key: ${cause.message}`,
          );
        throw cause;
      });
      if (account.zeroDataRetention)
        throw new OrbProviderCredentialsRejected(ZERO_DATA_RETENTION);
      if ((await api.limits()).plan === "trial")
        throw new OrbProviderCredentialsRejected(TRIAL);
      // A connection saved again keeps the snapshot this recipe saved.
      const saved = await api.savedSnapshot(boatSnapshotName(recipe));
      return preparing(account.id, {
        phase: saved?.status === "ready" ? "probing" : "creating",
      });
    },
    async advance(credentials, recipe, current) {
      const api = boatApi(apiKeyOf(credentials), send);
      const account = current.account ?? "";
      const state = stateOf(current);
      try {
        if (state.phase === "probing") {
          await probe(api, boatSnapshotName(recipe));
          const { sizes, unavailable } = await planSizes(api);
          await deleteStaleSnapshots(api, recipe);
          return {
            status: "ready",
            account,
            state: {
              phase: "probing",
              snapshot: boatSnapshotName(recipe),
              sizes,
              unavailable,
            } as unknown as OrbPreparation["state"],
            progress: null,
            error: null,
          };
        }
        let next: BoatState;
        try {
          const { failures: _, ...advanced } = await advanceBuild(
            api,
            recipe,
            state,
          );
          next = advanced;
        } catch (cause) {
          if (
            rejected(cause) ||
            refusedByPlan(cause) !== undefined ||
            cause instanceof BuildFailed
          )
            throw cause;
          const failures = (state.failures ?? 0) + 1;
          if (failures >= MAX_FAILURES)
            throw new BuildFailed(
              `Boat kept failing while building the Orb: ${cause instanceof Error ? cause.message : "unknown error"}`,
            );
          next = { ...state, failures };
        }
        return preparing(
          account,
          next,
          next.phase === "setup" || next.phase === "saving"
            ? BUILD_POLL_MS
            : STEP_MS,
        );
      } catch (cause) {
        const failed = rejected(cause)
          ? REJECTED
          : (refusedByPlan(cause) ??
            (cause instanceof BuildFailed ? cause.message : undefined));
        if (failed === undefined) throw cause;
        // A failed preparation leaves no build sandbox running in the account.
        if (state.buildSandbox !== undefined)
          await api.deleteSandbox(state.buildSandbox).catch(() => undefined);
        return failedPreparation(current, failed);
      }
    },
    targets: (preparation) => {
      if (preparation.status !== "ready") return undefined;
      const { snapshot, sizes } = stateOf(preparation);
      if (snapshot === undefined) return undefined;
      return new Map((sizes ?? []).map((size) => [size, snapshot] as const));
    },
    // A size the plan refuses has no target; a plan upgrade adds it when
    // Core prepares the connection again (from the saved snapshot).
    unavailable: (preparation) =>
      preparation.status !== "ready"
        ? undefined
        : new Map(Object.entries(stateOf(preparation).unavailable ?? {})),
  };
};
