import { DOCKER_ORB_SIZES, type OrbProviderCredentials } from "@dx/domain";
import publicImage from "../../../../../deploy/orb/public-image.json" with {
  type: "json",
};
import {
  failedPreparation,
  type OrbPreparation,
  type OrbProviderConnector,
  OrbProviderCredentialsRejected,
} from "../../plugins/execution/connector.js";
import {
  type DockerSandboxesApi,
  DockerSandboxesApiError,
  dockerSandboxesApi,
} from "./api.js";
import { ORB_USER } from "./guest.js";

/**
 * Docker Cloud Sandboxes in a person's or workspace's own Docker account
 * (tasks/orb-provider-connections.md). A sandbox boots an OCI image
 * directly, so there is nothing to build: Threads boot the public Orb image
 * (`deploy/orb/public-image.json`) by digest. Preparing an account checks,
 * on a test Orb, everything a Thread's Orb needs from Docker:
 *
 * 1. the image boots and `dx-orb-init` supervises as `user`;
 * 2. the sandbox's deadline can be moved (Core's idle pause);
 * 3. it stops and starts again, and `dx-orb-init` comes back;
 *
 * then deletes it. Each size's Threads pin the image the test booted.
 */

const STEP_MS = 2_000;
const POLL_MS = 5_000;
/** A first boot pulls the multi-GB Orb image: ten minutes of polls. */
const MAX_BOOT_POLLS = 120;
/** A stop or a start: three minutes of polls. */
const MAX_LIFECYCLE_POLLS = 36;
/** The test Orb deletes itself after this long if preparation stops. */
const PROBE_TIMEOUT_SECONDS = 1_800;
const SUPERVISING =
  'test -f /home/user/.local/state/dxd/supervisor.pid && kill -0 "$(cat /home/user/.local/state/dxd/supervisor.pid)"';

type Phase = "create" | "boot" | "check" | "pause" | "resume";

interface DockerState {
  readonly phase: Phase;
  /** The idempotency key of the test Orb's create. */
  readonly key?: string;
  readonly probe?: string;
  readonly polls?: number;
  /** The image the test Orb booted; Threads pin it once ready. */
  readonly image?: string;
}

const PHASES: ReadonlyArray<Phase> = [
  "create",
  "boot",
  "check",
  "pause",
  "resume",
];

const STEP_LABELS: Record<Phase, string> = {
  create: "Starting a test Orb in your Docker account",
  boot: "Starting a test Orb in your Docker account",
  check: "Checking the test Orb",
  pause: "Pausing the test Orb",
  resume: "Resuming the test Orb",
};

const REJECTED = "Docker rejected this Docker ID and access token.";
const NO_ACCESS =
  "This account cannot use Cloud Sandboxes. Create the token with Allow Cloud Sandboxes access, and activate the Docker Agentic Platform plan.";

const credentialsOf = (credentials: OrbProviderCredentials) => {
  const dockerId = credentials.dockerId;
  const accessToken = credentials.accessToken;
  if (dockerId === undefined || accessToken === undefined)
    throw new OrbProviderCredentialsRejected(
      "Enter your Docker ID and a personal access token.",
    );
  return { dockerId, accessToken };
};

const rejected = (cause: unknown) =>
  cause instanceof DockerSandboxesApiError && cause.status === 401;

const refused = (cause: unknown) =>
  cause instanceof DockerSandboxesApiError && cause.status === 403;

const invalid = (cause: unknown) =>
  cause instanceof DockerSandboxesApiError &&
  cause.status === 400 &&
  cause.code === "invalidArgument";

/** Docker answers a lifecycle call it does not offer this account so. */
const unsupported = (cause: unknown) =>
  cause instanceof DockerSandboxesApiError &&
  (cause.status === 501 ||
    cause.code === "unimplemented" ||
    cause.code === "notFound");

class ProbeFailed extends Error {}

const stateOf = (preparation: Pick<OrbPreparation, "state">): DockerState =>
  PHASES.includes(preparation.state.phase as Phase)
    ? (preparation.state as unknown as DockerState)
    : { phase: "create" };

const preparing = (
  account: string,
  state: DockerState,
  nextStepInMs = STEP_MS,
): OrbPreparation => ({
  status: "preparing",
  account,
  state: state as unknown as OrbPreparation["state"],
  progress: {
    step: STEP_LABELS[state.phase],
    done: PHASES.indexOf(state.phase),
    total: PHASES.length,
  },
  error: null,
  nextStepInMs,
});

/**
 * The public Orb image this build boots, when it is mirrored on Docker Hub:
 * Docker Cloud Sandboxes pull only from Docker Hub (`docker.io`) and Docker
 * Hardened Images, and refuse `ghcr.io`. The mirror carries the same digest.
 */
export const publicOrbImageRef = (): string | undefined =>
  publicImage.digest === null || !publicImage.dockerHubRepository
    ? undefined
    : `docker.io/${publicImage.dockerHubRepository}@${publicImage.digest}`;

const sha256 = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** Runs the supervisor check in the test Orb as the workspace account. */
const supervising = async (api: DockerSandboxesApi, probe: string) => {
  const ran = await api.endpoint(probe).exec({
    cmd: ["timeout", "20", "/bin/bash", "-c", `true && ${SUPERVISING}`],
    user: ORB_USER,
    timeoutMs: 60_000,
  });
  return ran.exitCode === 0;
};

/**
 * Docker Cloud Sandboxes connections, or undefined when this build has no
 * published Orb image to boot.
 */
export const makeDockerConnector = (
  options: { readonly fetch?: typeof fetch; readonly image?: string } = {},
): OrbProviderConnector | undefined => {
  const image = options.image ?? publicOrbImageRef();
  if (image === undefined) return undefined;
  const send: typeof fetch = (...args) => (options.fetch ?? fetch)(...args);
  const smallest = DOCKER_ORB_SIZES[0];
  if (smallest === undefined) return undefined;

  const step = async (
    api: DockerSandboxesApi,
    account: string,
    state: DockerState,
  ): Promise<OrbPreparation> => {
    const polls = state.polls ?? 0;
    switch (state.phase) {
      case "create": {
        const key = state.key ?? `dx-orb-probe-${crypto.randomUUID()}`;
        const created = await api
          .createSandbox({
            imageRef: image,
            cpus: smallest.resources.cpuCores,
            memoryMib: smallest.resources.memoryMb,
            timeoutSeconds: PROBE_TIMEOUT_SECONDS,
            onTimeout: "delete",
            displayNamePrefix: "dx-orb-probe-",
            labels: { dxOrbProbe: "1" },
            idempotencyKey: key,
          })
          .catch((cause: unknown) => {
            // A request Docker calls invalid (an image registry it does not
            // pull from) fails the same way on every retry.
            if (invalid(cause))
              throw new ProbeFailed(
                `Docker refused the Orb image: ${(cause as Error).message}`,
              );
            throw cause;
          });
        return preparing(
          account,
          { phase: "boot", key, probe: created.uid, image, polls: 0 },
          POLL_MS,
        );
      }
      case "boot": {
        const probe = state.probe as string;
        const current = await api.getSandbox(probe);
        if (current === undefined || current.status === "deleting")
          return preparing(account, { phase: "create" });
        if (current.status === "failed")
          throw new ProbeFailed(
            `Docker could not start the Orb image: ${current.failure ?? "unknown error"}`,
          );
        if (current.status === "running")
          return preparing(account, { ...state, phase: "check", polls: 0 });
        if (polls >= MAX_BOOT_POLLS)
          throw new ProbeFailed("The test Orb did not start in ten minutes.");
        return preparing(account, { ...state, polls: polls + 1 }, POLL_MS);
      }
      case "check": {
        const probe = state.probe as string;
        if (!(await supervising(api, probe)))
          throw new ProbeFailed(
            "The test Orb started, but its Orb supervisor is not running as user.",
          );
        await api
          .renewTimeout(probe, PROBE_TIMEOUT_SECONDS)
          .catch((cause: unknown) => {
            if (unsupported(cause))
              throw new ProbeFailed(
                "Docker would not move the test Orb's deadline, which dx needs to pause idle Orbs.",
              );
            throw cause;
          });
        const current = await api.getSandbox(probe);
        if (current === undefined)
          return preparing(account, { phase: "create" });
        await api.stopSandbox(current).catch((cause: unknown) => {
          if (unsupported(cause))
            throw new ProbeFailed(
              "Docker would not pause the test Orb, which dx needs to stop idle Orbs.",
            );
          throw cause;
        });
        return preparing(account, { ...state, phase: "pause", polls: 0 });
      }
      case "pause": {
        const probe = state.probe as string;
        const current = await api.getSandbox(probe);
        if (current === undefined)
          return preparing(account, { phase: "create" });
        if (current.status === "failed")
          throw new ProbeFailed(
            `The test Orb failed while pausing: ${current.failure ?? "unknown error"}`,
          );
        if (current.status === "stopped") {
          await api.startSandbox(current);
          return preparing(
            account,
            { ...state, phase: "resume", polls: 0 },
            POLL_MS,
          );
        }
        if (polls >= MAX_LIFECYCLE_POLLS)
          throw new ProbeFailed("The test Orb did not pause in three minutes.");
        return preparing(account, { ...state, polls: polls + 1 }, POLL_MS);
      }
      case "resume": {
        const probe = state.probe as string;
        const current = await api.getSandbox(probe);
        if (current === undefined)
          return preparing(account, { phase: "create" });
        if (current.status === "failed" || current.status === "stopped")
          throw new ProbeFailed(
            `The test Orb did not resume${current.failure === undefined ? "" : `: ${current.failure}`}`,
          );
        if (current.status !== "running") {
          if (polls >= MAX_LIFECYCLE_POLLS)
            throw new ProbeFailed(
              "The test Orb did not resume in three minutes.",
            );
          return preparing(account, { ...state, polls: polls + 1 }, POLL_MS);
        }
        if (!(await supervising(api, probe)))
          throw new ProbeFailed(
            "The test Orb resumed, but its Orb supervisor did not come back.",
          );
        await api.deleteSandbox(probe);
        return {
          status: "ready",
          account,
          state: {
            phase: "resume",
            image,
          } as unknown as OrbPreparation["state"],
          progress: null,
          error: null,
        };
      }
    }
  };

  let recipe: Promise<string> | undefined;
  return {
    providerId: "docker",
    description:
      "Runs Orbs as Docker Cloud Sandboxes in your own Docker account, which needs the Docker Agentic Platform plan. dx starts and checks a test Orb there first, which takes a few minutes.",
    fields: [
      {
        id: "dockerId",
        label: "Docker ID",
        secret: false,
        help: "The username you sign in to Docker with.",
      },
      {
        id: "accessToken",
        label: "Personal access token",
        secret: true,
        help: "Create one in Docker Home under Account settings → Personal access tokens, with Allow Cloud Sandboxes access.",
      },
    ],
    recipe: () => {
      recipe ??= sha256(
        ["docker", image, JSON.stringify(DOCKER_ORB_SIZES)].join("\0"),
      ).then((digest) => digest.slice(0, 16));
      return recipe;
    },
    async start(credentials) {
      const api = dockerSandboxesApi(credentialsOf(credentials), send);
      const account = await api.account().catch((cause: unknown) => {
        if (rejected(cause)) throw new OrbProviderCredentialsRejected(REJECTED);
        throw cause;
      });
      await api.checkAccess().catch((cause: unknown) => {
        if (rejected(cause) || refused(cause))
          throw new OrbProviderCredentialsRejected(NO_ACCESS);
        throw cause;
      });
      return preparing(account, { phase: "create" });
    },
    async advance(credentials, _recipe, current) {
      const api = dockerSandboxesApi(credentialsOf(credentials), send);
      const account = current.account ?? "";
      const state = stateOf(current);
      try {
        return await step(api, account, state);
      } catch (cause) {
        const failed = rejected(cause)
          ? REJECTED
          : refused(cause)
            ? NO_ACCESS
            : cause instanceof ProbeFailed
              ? cause.message
              : undefined;
        if (failed === undefined) throw cause;
        // A failed preparation leaves no test Orb in the account.
        if (state.probe !== undefined)
          await api.deleteSandbox(state.probe).catch(() => undefined);
        return failedPreparation(current, failed);
      }
    },
    targets: (preparation) => {
      if (preparation.status !== "ready") return undefined;
      const pinned = stateOf(preparation).image;
      return pinned === undefined
        ? undefined
        : new Map(DOCKER_ORB_SIZES.map(({ id }) => [id, pinned] as const));
    },
  };
};
