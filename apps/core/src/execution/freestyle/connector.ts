import { FREESTYLE_ORB_SIZES, type OrbProviderCredentials } from "@dx/domain";
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
import { type FreestyleApi, FreestyleApiError, freestyleApi } from "./api.js";
import { freestyleBuildGuest } from "./guest.js";

/**
 * Freestyle in a person's or workspace's own account
 * (tasks/orb-provider-connections.md). Freestyle VMs boot from snapshots,
 * not OCI images, and a snapshot keeps the hardware it was taken at. So
 * preparing an account builds one dx Orb snapshot per size: a VM from that
 * size's Ubuntu base runs deploy/orb/vm-setup.sh, and once it is done the
 * VM is snapshotted (memory and disk) and deleted. The builds run side by
 * side. A size the account's plan does not allow is skipped. Then a test
 * Orb boots from the smallest snapshot, runs `true` as the workspace
 * account, checks that dx-orb-init is supervising, and is deleted.
 *
 * Threads pin their size's snapshot and boot from it.
 */

const STEP_MS = 2_000;
const BUILD_POLL_MS = 10_000;
/** Snapshots of earlier recipes are deleted once this old. */
const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1_000;
const ORB_USER = "user";
/** A size whose calls keep failing this many steps in a row fails preparation. */
const MAX_BUILD_FAILURES = 10;

type BuildStatus = "pending" | "starting" | "building" | "ready" | "skipped";

interface SizeBuild {
  readonly profileId: string;
  readonly status: BuildStatus;
  readonly vmId?: string;
  readonly snapshotId?: string;
  /** Why a size was skipped. */
  readonly note?: string;
  /** Steps in a row whose Freestyle call failed for this size. */
  readonly failures?: number;
}

interface FreestyleState {
  readonly builds: ReadonlyArray<SizeBuild>;
  /** Every size is settled; the next step starts the test Orb. */
  readonly probing?: true;
}

type Fetch = typeof fetch;

const snapshotName = (recipe: string, profileId: string) =>
  `dx-orb-${recipe}-${profileId}`;

const apiKeyOf = (credentials: OrbProviderCredentials) => {
  const apiKey = credentials.apiKey;
  if (apiKey === undefined)
    throw new OrbProviderCredentialsRejected("Enter a Freestyle API key.");
  return apiKey;
};

const REJECTED = "Freestyle rejected this API key.";

const rejected = (cause: unknown) =>
  cause instanceof FreestyleApiError &&
  (cause.status === 401 || cause.status === 403);

const stateOf = (preparation: Pick<OrbPreparation, "state">): FreestyleState =>
  Array.isArray(preparation.state.builds)
    ? (preparation.state as unknown as FreestyleState)
    : { builds: [] };

const progressOf = (builds: ReadonlyArray<SizeBuild>) => {
  const building = builds
    .filter(({ status }) => status === "starting" || status === "building")
    .map(({ profileId }) => profileId);
  return {
    step:
      building.length === 0
        ? "Starting a test Orb"
        : `Building the Orb (${building.join(", ")}) in your Freestyle account`,
    done: builds.filter(
      ({ status }) => status === "ready" || status === "skipped",
    ).length,
    total: builds.length + 1,
  };
};

const preparing = (
  account: string,
  state: FreestyleState,
  nextStepInMs = STEP_MS,
): OrbPreparation => ({
  status: "preparing",
  account,
  state: state as unknown as OrbPreparation["state"],
  progress: progressOf(state.builds),
  error: null,
  nextStepInMs,
});

/** Plan limits refuse a size outright; anything else is retried. */
const refusedByPlan = (cause: unknown) =>
  cause instanceof FreestyleApiError &&
  (cause.status === 400 || cause.status === 429) &&
  cause.code !== "UNKNOWN_ERROR";

/** One step of one size's build. */
const advanceBuild = async (
  api: FreestyleApi,
  recipe: string,
  build: SizeBuild,
  smallest: boolean,
): Promise<SizeBuild> => {
  const size = FREESTYLE_ORB_SIZES.find(({ id }) => id === build.profileId);
  if (size === undefined) return { ...build, status: "skipped" };
  switch (build.status) {
    case "pending": {
      const vm = await api
        .createVm({
          snapshotId: size.baseSnapshot,
          displayName: `dx-orb-build-${recipe}-${size.id}`,
          metadata: { dxOrbBuild: recipe },
        })
        .catch((cause: unknown) => {
          if (!smallest && refusedByPlan(cause))
            return { skipped: (cause as FreestyleApiError).message };
          throw cause;
        });
      if ("skipped" in vm)
        return { ...build, status: "skipped", note: vm.skipped };
      return { ...build, status: "starting", vmId: vm.id };
    }
    case "starting": {
      const vm = await api.getVm(build.vmId as string);
      if (vm === undefined)
        return { profileId: build.profileId, status: "pending" };
      if (vm.state !== "running") return build;
      await startVmOrbSetup(freestyleBuildGuest(api, vm.id));
      return { ...build, status: "building" };
    }
    case "building": {
      const guest = freestyleBuildGuest(api, build.vmId as string);
      const status = await vmOrbSetupStatus(guest);
      if (status.state === "running") return build;
      if (status.state === "failed") {
        await api.deleteVm(build.vmId as string).catch(() => undefined);
        throw new BuildFailed(
          `The Orb setup failed in the ${size.id} VM${status.log === "" ? "" : `: ${status.log}`}`,
        );
      }
      const snapshotId = await api.snapshot(
        build.vmId as string,
        snapshotName(recipe, size.id),
      );
      await api.deleteVm(build.vmId as string).catch(() => undefined);
      return { profileId: build.profileId, status: "ready", snapshotId };
    }
    case "ready":
    case "skipped":
      return build;
  }
};

class BuildFailed extends Error {}

/** Boots the smallest snapshot and checks the Orb inside, then deletes it. */
const probe = async (api: FreestyleApi, snapshotId: string) => {
  const vm = await api.createVm({
    snapshotId,
    displayName: "dx-orb-probe",
    metadata: { dxOrbProbe: "1" },
  });
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const current = await api.getVm(vm.id);
      if (current?.state === "running") break;
      if (Date.now() > deadline)
        throw new BuildFailed("The test Orb did not start.");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const ran = await api.exec(vm.id, {
      command:
        'true && test -f /home/user/.local/state/dxd/supervisor.pid && kill -0 "$(cat /home/user/.local/state/dxd/supervisor.pid)"',
      linuxUser: ORB_USER,
      timeoutMs: 30_000,
    });
    if (ran.statusCode !== 0)
      throw new BuildFailed("The test Orb could not run a command.");
  } finally {
    await api.deleteVm(vm.id).catch(() => undefined);
  }
};

/** Deletes Orb snapshots an earlier recipe made, once they are old. */
const deleteStaleSnapshots = async (api: FreestyleApi, recipe: string) => {
  const listed = await api.snapshots("dx-orb-").catch(() => []);
  for (const { id, name, createdAt } of listed) {
    const created = Date.parse(createdAt);
    if (
      /^dx-orb-[0-9a-f]{16}-/.test(name) &&
      !name.startsWith(`dx-orb-${recipe}-`) &&
      Number.isFinite(created) &&
      Date.now() - created >= STALE_SNAPSHOT_MS
    )
      await api.deleteSnapshot(id).catch(() => undefined);
  }
};

export const makeFreestyleConnector = (
  options: { readonly fetch?: Fetch } = {},
): OrbProviderConnector => {
  const send: Fetch = (...args) => (options.fetch ?? fetch)(...args);
  let recipe: Promise<string> | undefined;
  return {
    providerId: "freestyle",
    description:
      "Runs Orbs as Freestyle VMs in your own account. dx builds its Orb snapshots there first, which takes about ten minutes.",
    fields: [
      {
        id: "apiKey",
        label: "Freestyle API key",
        secret: true,
        help: "Create one in the Freestyle dashboard (dash.freestyle.sh) under API Keys.",
      },
    ],
    recipe: () => {
      recipe ??= vmOrbRecipe(
        `freestyle\0${JSON.stringify(FREESTYLE_ORB_SIZES)}`,
      );
      return recipe;
    },
    async start(credentials, recipe) {
      const api = freestyleApi(apiKeyOf(credentials), send);
      const account = await api.accountId().catch((cause: unknown) => {
        if (rejected(cause)) throw new OrbProviderCredentialsRejected(REJECTED);
        throw cause;
      });
      // A connection saved again keeps the snapshots this recipe made.
      const existing = new Map(
        (await api.snapshots(`dx-orb-${recipe}-`)).map(({ id, name }) => [
          name,
          id,
        ]),
      );
      return preparing(account, {
        builds: FREESTYLE_ORB_SIZES.map(({ id }): SizeBuild => {
          const snapshotId = existing.get(snapshotName(recipe, id));
          return snapshotId === undefined
            ? { profileId: id, status: "pending" }
            : { profileId: id, status: "ready", snapshotId };
        }),
      });
    },
    async advance(credentials, recipe, current) {
      const api = freestyleApi(apiKeyOf(credentials), send);
      const account = current.account ?? "";
      const { builds, probing } = stateOf(current);
      let buildVms: ReadonlyArray<string> = [];
      try {
        // Each size keeps what its own step did, so a failed call for one
        // size never loses (and orphans) a VM another size just created.
        const outcomes = await Promise.allSettled(
          builds.map((build, index) =>
            advanceBuild(api, recipe, build, index === 0),
          ),
        );
        const known = [
          ...builds,
          ...outcomes.flatMap((outcome) =>
            outcome.status === "fulfilled" ? [outcome.value] : [],
          ),
        ];
        buildVms = known.flatMap(({ status, vmId }) =>
          vmId === undefined || status === "ready" ? [] : [vmId],
        );
        const advanced = outcomes.map((outcome, index): SizeBuild => {
          const build = builds[index] as SizeBuild;
          if (outcome.status === "fulfilled") {
            const { failures: _, ...next } = outcome.value;
            return next;
          }
          const cause: unknown = outcome.reason;
          if (rejected(cause) || cause instanceof BuildFailed) throw cause;
          const failures = (build.failures ?? 0) + 1;
          if (failures >= MAX_BUILD_FAILURES)
            throw new BuildFailed(
              `Freestyle kept failing while building ${build.profileId}: ${cause instanceof Error ? cause.message : "unknown error"}`,
            );
          return { ...build, failures };
        });
        const settled = advanced.every(
          ({ status }) => status === "ready" || status === "skipped",
        );
        if (!settled)
          return preparing(
            account,
            { builds: advanced },
            advanced.some(({ status }) => status === "building")
              ? BUILD_POLL_MS
              : STEP_MS,
          );
        if (probing !== true)
          return preparing(account, { builds: advanced, probing: true });
        const smallest = advanced.find(({ status }) => status === "ready");
        if (smallest?.snapshotId === undefined)
          return failedPreparation(
            current,
            "Freestyle built no Orb size for this account.",
          );
        await probe(api, smallest.snapshotId);
        await deleteStaleSnapshots(api, recipe);
        return {
          status: "ready",
          account,
          state: { builds: advanced } as unknown as OrbPreparation["state"],
          progress: null,
          error: null,
        };
      } catch (cause) {
        const failed = rejected(cause)
          ? REJECTED
          : cause instanceof BuildFailed
            ? cause.message
            : undefined;
        if (failed === undefined) throw cause;
        // A failed preparation leaves no build VM running in the account.
        await Promise.all(
          buildVms.map((vm) => api.deleteVm(vm).catch(() => undefined)),
        );
        return failedPreparation(current, failed);
      }
    },
    targets: (preparation) =>
      preparation.status !== "ready"
        ? undefined
        : new Map(
            stateOf(preparation).builds.flatMap(({ profileId, snapshotId }) =>
              snapshotId === undefined
                ? []
                : [[profileId, snapshotId] as const],
            ),
          ),
    // A size the plan refused (Free allows 4 vCPUs per VM) has no snapshot.
    unavailable: (preparation) =>
      preparation.status !== "ready"
        ? undefined
        : new Map(
            stateOf(preparation).builds.flatMap(
              ({ profileId, status, note }) =>
                status === "skipped"
                  ? [
                      [
                        profileId,
                        note ?? "Your Freestyle plan does not allow this size.",
                      ] as const,
                    ]
                  : [],
            ),
          ),
  };
};
