import { AGENT37_ORB_SIZES, type OrbProviderCredentials } from "@dx/domain";
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
  ORB_CHECK_COMMAND,
  ORB_CHECK_TIMEOUT_SECONDS,
  orbCheckFailure,
} from "../guest/orb-check.js";
import { type Agent37Api, Agent37ApiError, agent37Api } from "./api.js";
import { AGENT37_MOUNT_PATH, sleepAgent37Instance } from "./provider.js";

/**
 * Agent37 in a person's or workspace's own Agent37 workspace, or a
 * deployment Orb account its admin added in the panel. Agent37 runs any public amd64 image
 * registered as a workspace template, copied once into its private
 * storage and pinned by digest, so preparing an account registers the
 * public Orb image (`deploy/orb/public-image.json`) as the template
 * `dx-orb-<recipe>`. A test Orb then starts from it, checks that
 * dx-orb-init (the image's entrypoint) supervises, runs dx-orb-check
 * (every workspace feature, the Desktop included), and is deleted.
 * Threads of every size pin that template.
 */

const STEP_MS = 2_000;
/** Steps in a row whose Agent37 call failed before preparation fails. */
const MAX_FAILURES = 10;

type Phase = "register" | "probe" | "check";

interface Agent37State {
  readonly phase: Phase;
  /** The test Orb, once created. */
  readonly probe?: string;
  readonly failures?: number;
  /** Once ready: the template every size's Threads pin. */
  readonly template?: string;
}

/** The public Orb image on ghcr.io, which Agent37 pulls without a login. */
const publicOrbImageRef = (): string | undefined =>
  publicImage.digest === null
    ? undefined
    : `${publicImage.registry}/${publicImage.repository}@${publicImage.digest}`;

/** The one template a recipe registers; every size starts from it. */
export const agent37TemplateName = (recipe: string) => `dx-orb-${recipe}`;

const apiKeyOf = (credentials: OrbProviderCredentials) => {
  const apiKey = credentials.apiKey;
  if (apiKey === undefined)
    throw new OrbProviderCredentialsRejected("Enter an Agent37 API key.");
  return apiKey;
};

const REJECTED = "Agent37 rejected this API key.";

const rejected = (cause: unknown) =>
  cause instanceof Agent37ApiError && cause.status === 401;

/** What Agent37's wallet or limits refuse, in its own words. */
const refusedByAccount = (cause: unknown) =>
  cause instanceof Agent37ApiError &&
  (cause.status === 402 ||
    cause.status === 403 ||
    cause.code === "instance_limit_reached")
    ? `Agent37 refused: ${cause.message}`
    : undefined;

class PreparationFailed extends Error {}

const stateOf = (preparation: Pick<OrbPreparation, "state">): Agent37State =>
  typeof preparation.state.phase === "string"
    ? (preparation.state as unknown as Agent37State)
    : { phase: "register" };

const preparing = (
  account: string,
  state: Agent37State,
  nextStepInMs = STEP_MS,
): OrbPreparation => ({
  status: "preparing",
  account,
  state: state as unknown as OrbPreparation["state"],
  progress: {
    step:
      state.phase === "register"
        ? "Copying the Orb image into your Agent37 workspace"
        : "Starting a test Orb",
    done: state.phase === "register" ? 0 : 1,
    total: 2,
  },
  error: null,
  nextStepInMs,
});

/** dx-orb-init, the entrypoint, supervises as `user` within a minute. */
const SUPERVISING =
  'for _ in $(seq 1 60); do pid=$(cat /home/user/.local/state/dxd/supervisor.pid 2>/dev/null); if test "$(id -un)" = user && test -n "$pid" && kill -0 "$pid" 2>/dev/null; then exit 0; fi; sleep 1; done; exit 1';

/** One step; returns the next state, or the template once checked. */
const step = async (
  api: Agent37Api,
  image: string,
  recipe: string,
  state: Agent37State,
): Promise<Agent37State> => {
  const template = agent37TemplateName(recipe);
  switch (state.phase) {
    case "register": {
      if ((await api.template(template)) === undefined)
        await api
          .registerTemplate({
            name: template,
            imageRef: image,
            description: "dx Orb (managed by dx; Threads start from it)",
          })
          .catch((cause: unknown) => {
            // A registration an earlier step started, which went through.
            if (
              cause instanceof Agent37ApiError &&
              cause.code === "template_conflict"
            )
              return;
            if (cause instanceof Agent37ApiError && cause.status === 400)
              throw new PreparationFailed(
                `Agent37 could not copy the Orb image: ${cause.message}`,
              );
            throw cause;
          });
      return { phase: "probe" };
    }
    case "probe": {
      const smallest = AGENT37_ORB_SIZES[0];
      if (smallest === undefined) throw new PreparationFailed("no Orb size");
      const created = await api.createInstance({
        template,
        resources: {
          cpu: smallest.resources.cpuCores,
          memory: Math.round(smallest.resources.memoryMb / 1024),
          disk: smallest.resources.diskGb,
        },
        name: "dx-orb-probe",
        mountPath: AGENT37_MOUNT_PATH,
        metadata: { dx: "orb-probe" },
      });
      return { phase: "check", probe: created.id };
    }
    case "check": {
      const probe = state.probe as string;
      const current = await api.getInstance(probe);
      if (current === undefined || current.status === "failed") {
        if (current !== undefined)
          await api.deleteInstance(probe).catch(() => undefined);
        throw new PreparationFailed("The test Orb did not start.");
      }
      if (current.status !== "running") return state;
      try {
        const ran = await api.exec(probe, `true && ${SUPERVISING}`, {
          timeoutSeconds: 90,
        });
        if (ran.exitCode !== 0)
          throw new PreparationFailed(
            "The test Orb did not start dx-orb-init.",
          );
        const checked = await api.exec(probe, ORB_CHECK_COMMAND, {
          timeoutSeconds: ORB_CHECK_TIMEOUT_SECONDS,
        });
        const failure = orbCheckFailure(checked.stdout, checked.exitCode);
        if (failure !== undefined) throw new PreparationFailed(failure);
      } finally {
        await api.deleteInstance(probe).catch(() => undefined);
      }
      return { phase: "check", template };
    }
  }
};

/**
 * The connector for Agent37. `image` replaces the published Orb image
 * (a branch preview's own); undefined until an image is published.
 */
export const makeAgent37Connector = (
  options: { readonly fetch?: typeof fetch; readonly image?: string } = {},
): OrbProviderConnector | undefined => {
  const image = options.image ?? publicOrbImageRef();
  if (image === undefined) return undefined;
  const send: typeof fetch = (...args) => (options.fetch ?? fetch)(...args);
  let recipe: Promise<string> | undefined;
  return {
    providerId: "agent37",
    description:
      "Runs Orbs as Agent37 instances in your own Agent37 workspace, billed to its wallet. dx copies its Orb image there and checks a test Orb first, which takes a few minutes.",
    fields: [
      {
        id: "apiKey",
        label: "Agent37 API key",
        secret: true,
        help: "Create one in the Agent37 dashboard (agent37.com) under Cloud, API keys. It starts with sk_live_.",
      },
    ],
    recipe: () => {
      recipe ??= crypto.subtle
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            [
              "agent37",
              image,
              AGENT37_MOUNT_PATH,
              // The shared sizes as they were before VM sizes, so adding
              // sizes asks no account to register its template again: the
              // template serves every size and type.
              JSON.stringify(
                AGENT37_ORB_SIZES.filter(
                  ({ instanceType }) => instanceType === "default",
                ).map(({ id, label, resources }) => ({ id, label, resources })),
              ),
            ].join("\0"),
          ),
        )
        .then((digest) =>
          [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 16),
        );
      return recipe;
    },
    async start(credentials, recipe) {
      const api = agent37Api(apiKeyOf(credentials), send);
      // The workspace's first member, who created it: the same for every
      // key of the workspace, so a new key keeps pinned Threads.
      const members = await api.members().catch((cause: unknown) => {
        if (rejected(cause)) throw new OrbProviderCredentialsRejected(REJECTED);
        if (cause instanceof Agent37ApiError && cause.status === 403)
          throw new OrbProviderCredentialsRejected(
            `Agent37 refused this API key: ${cause.message}`,
          );
        throw cause;
      });
      const owner = members[0]?.id;
      if (owner === undefined)
        throw new OrbProviderCredentialsRejected(
          "Agent37 named no member of this key's workspace.",
        );
      // A connection saved again keeps the template this recipe registered.
      const registered = await api.template(agent37TemplateName(recipe));
      return preparing(owner, {
        phase: registered === undefined ? "register" : "probe",
      });
    },
    async advance(credentials, recipe, current) {
      const api = agent37Api(apiKeyOf(credentials), send);
      const account = current.account ?? "";
      const state = stateOf(current);
      try {
        let next: Agent37State;
        try {
          const { failures: _, ...advanced } = await step(
            api,
            image,
            recipe,
            state,
          );
          next = advanced;
        } catch (cause) {
          if (
            rejected(cause) ||
            refusedByAccount(cause) !== undefined ||
            cause instanceof PreparationFailed
          )
            throw cause;
          const failures = (state.failures ?? 0) + 1;
          if (failures >= MAX_FAILURES)
            throw new PreparationFailed(
              `Agent37 kept failing while preparing the Orb: ${cause instanceof Error ? cause.message : "unknown error"}`,
            );
          next = { ...state, failures };
        }
        if (next.template !== undefined)
          return {
            status: "ready",
            account,
            state: next as unknown as OrbPreparation["state"],
            progress: null,
            error: null,
          };
        return preparing(account, next);
      } catch (cause) {
        const failed = rejected(cause)
          ? REJECTED
          : (refusedByAccount(cause) ??
            (cause instanceof PreparationFailed ? cause.message : undefined));
        if (failed === undefined) throw cause;
        // A failed preparation leaves no test Orb in the workspace.
        if (state.probe !== undefined)
          await api.deleteInstance(state.probe).catch(() => undefined);
        return failedPreparation(current, failed);
      }
    },
    targets: (preparation) => {
      if (preparation.status !== "ready") return undefined;
      const { template } = stateOf(preparation);
      return template === undefined
        ? undefined
        : new Map(AGENT37_ORB_SIZES.map(({ id }) => [id, template] as const));
    },
    pause: (credentials, instanceId) =>
      sleepAgent37Instance(agent37Api(apiKeyOf(credentials), send), instanceId),
  };
};
