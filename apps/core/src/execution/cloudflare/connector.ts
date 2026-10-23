import {
  CLOUDFLARE_ORB_PROFILES,
  type OrbProviderCredentials,
} from "@dx/domain";
import publicImage from "../../../../../deploy/orb/public-image.json" with {
  type: "json",
};
import {
  failedPreparation,
  type OrbPreparation,
  type OrbProviderConnector,
  OrbProviderCredentialsRejected,
} from "../../plugins/execution/connector.js";
import { accountOrbContainer, accountOrbHealth } from "./account-orb-client.js";
import { ACCOUNT_ORB_PROTOCOL } from "./account-orb-protocol.js";
import accountOrbWorker from "./account-orb-worker.generated.js?raw";
import {
  advanceOciCopy,
  type OciCopyState,
  type OciImageSource,
  startOciCopy,
} from "./oci-copy.js";

/**
 * Cloudflare Containers in a person's or workspace's own Cloudflare account
 * (tasks/orb-provider-connections.md). Core cannot bind a Durable Object
 * namespace in another account, and a `durable_object` container image has
 * to be digest-pinned in that account's own registry. Preparing an account:
 *
 * 1. verify the API token and that the account has Containers;
 * 2. copy the public Orb image into the account's registry;
 * 3. have Cloudflare prepare that image;
 * 4. upload the account Orb Worker (`account-orb-worker.ts`) with the image
 *    and the connection's secret, create its container application, and
 *    serve it on the account's workers.dev subdomain;
 * 5. check the Worker answers, then start a test Orb, run a command in it,
 *    and destroy it.
 *
 * Threads then pin the Worker's URL and reach their containers through it.
 */

const API = "https://api.cloudflare.com/client/v4";
const REGISTRY = "registry.cloudflare.com";
const ORB_CONTAINER_CLASS = "OrbContainerObject";
const ORB_MIGRATION_TAG = "v1-orb-container";
/** deploy/orb/containers.mjs uses the same date for the deployer's Orb Worker. */
const ORB_COMPATIBILITY_DATE = "2026-09-29";
const STEP_MS = 2_000;
const POLL_MS = 5_000;

type Phase =
  | "image"
  | "image-preparation"
  | "worker"
  | "application"
  | "route"
  | "health"
  | "probe";

interface CloudflareState {
  readonly phase: Phase;
  readonly subdomain: string;
  readonly copy?: OciCopyState;
  readonly image?: string;
  readonly endpoint?: string;
  readonly healthAttempts?: number;
}

const PHASES: ReadonlyArray<Phase> = [
  "image",
  "image-preparation",
  "worker",
  "application",
  "route",
  "health",
  "probe",
];

const STEP_LABELS: Record<Phase, string> = {
  image: "Copying the Orb image into your Cloudflare account",
  "image-preparation": "Cloudflare is preparing the Orb image",
  worker: "Deploying the Orb Worker",
  application: "Creating the Orb container application",
  route: "Publishing the Orb Worker on workers.dev",
  health: "Waiting for the Orb Worker to answer",
  probe: "Starting a test Orb",
};

type Fetch = typeof fetch;

interface Credentials {
  readonly accountId: string;
  readonly apiToken: string;
  readonly workerSecret: string;
  readonly workerName: string;
}

const credentialsOf = (credentials: OrbProviderCredentials): Credentials => {
  const { accountId, apiToken, workerSecret, workerName } = credentials;
  if (
    accountId === undefined ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    apiToken === undefined
  )
    throw new OrbProviderCredentialsRejected(
      "Enter your 32-character Cloudflare account ID and an API token.",
    );
  if (workerSecret === undefined || workerName === undefined)
    throw new Error("The connection has no Orb Worker identity.");
  return { accountId, apiToken, workerSecret, workerName };
};

/** One Cloudflare API call; `undefined` result on a 404. */
const api = async <T>(
  send: Fetch,
  credentials: Credentials,
  path: string,
  init: RequestInit = {},
): Promise<{
  readonly status: number;
  readonly result: T | undefined;
  readonly errors: ReadonlyArray<{
    readonly code?: number;
    readonly message?: string;
  }>;
}> => {
  const response = await send(
    `${API}/accounts/${credentials.accountId}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${credentials.apiToken}`,
        ...(typeof init.body === "string"
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    readonly result?: T;
    readonly errors?: ReadonlyArray<{
      readonly code?: number;
      readonly message?: string;
    }>;
  };
  return {
    status: response.status,
    result: body.result,
    errors: body.errors ?? [],
  };
};

const rejectedToken = () =>
  new OrbProviderCredentialsRejected(
    "Cloudflare refused this token for the account. It needs Workers Scripts Edit, Containers Edit, and Account Settings Read, on an account with the Workers Paid plan.",
  );

const failure = (
  what: string,
  result: {
    readonly status: number;
    readonly errors: ReadonlyArray<{ readonly message?: string }>;
  },
) =>
  new Error(
    `${what} (${result.status}${result.errors[0]?.message === undefined ? "" : `: ${result.errors[0].message}`}).`,
  );

const stateOf = (preparation: Pick<OrbPreparation, "state">) =>
  preparation.state as unknown as CloudflareState;

const preparing = (
  account: string,
  state: CloudflareState,
  nextStepInMs = STEP_MS,
): OrbPreparation => {
  const index = PHASES.indexOf(state.phase);
  const copied =
    state.phase === "image" && state.copy !== undefined
      ? ` (${state.copy.next} of ${state.copy.blobs.length} layers)`
      : "";
  return {
    status: "preparing",
    account,
    state: state as unknown as OrbPreparation["state"],
    progress: {
      step: `${STEP_LABELS[state.phase]}${copied}`,
      done: index,
      total: PHASES.length,
    },
    error: null,
    nextStepInMs,
  };
};

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (text: string) =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );

/** The public Orb image this build copies, when one is published. */
export const publicOrbImage = (): OciImageSource | undefined =>
  publicImage.digest === null
    ? undefined
    : {
        registry: publicImage.registry,
        repository: publicImage.repository,
        reference: publicImage.digest,
      };

/** The multipart upload of the account Orb Worker. */
const workerUpload = (
  credentials: Credentials,
  image: string,
  recipe: string,
  migrate: boolean,
) => {
  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "account-orb-worker.js",
          compatibility_date: ORB_COMPATIBILITY_DATE,
          compatibility_flags: ["nodejs_compat"],
          bindings: [
            {
              type: "durable_object_namespace",
              name: "ORB_CONTAINER",
              class_name: ORB_CONTAINER_CLASS,
            },
            {
              type: "secret_text",
              name: "DX_ORB_WORKER_SECRET",
              text: credentials.workerSecret,
            },
            // `/health` reports it, so preparation knows this upload serves.
            { type: "plain_text", name: "DX_ORB_RECIPE", text: recipe },
          ],
          containers: [
            {
              name: `${credentials.workerName}-orbcontainerobject`,
              class_name: ORB_CONTAINER_CLASS,
              images: { orb: image },
            },
          ],
          ...(migrate
            ? {
                migrations: {
                  new_tag: ORB_MIGRATION_TAG,
                  new_sqlite_classes: [ORB_CONTAINER_CLASS],
                },
              }
            : {}),
          observability: { enabled: true },
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.set(
    "account-orb-worker.js",
    new Blob([accountOrbWorker], { type: "application/javascript+module" }),
    "account-orb-worker.js",
  );
  return form;
};

/** Random hex, for the Worker's secret and name. */
const randomHex = (bytes: number) =>
  hex(crypto.getRandomValues(new Uint8Array(bytes)));

export const makeCloudflareConnector = (
  options: {
    readonly fetch?: Fetch;
    readonly image?: OciImageSource;
    /** Starts the test Orb; tests replace the container round trip. */
    readonly probe?: (endpoint: string, secret: string) => Promise<void>;
  } = {},
): OrbProviderConnector | undefined => {
  const image = options.image ?? publicOrbImage();
  if (image === undefined) return undefined;
  const send: Fetch = (...args) => (options.fetch ?? fetch)(...args);
  const probe =
    options.probe ??
    (async (endpoint: string, secret: string) => {
      const orb = accountOrbContainer({
        endpoint,
        secret,
        threadId: `dx-probe-${randomHex(8)}`,
        fetch: send,
      });
      try {
        const opened = await orb.open({
          create: true,
          instance: "standard-1",
          idleMs: 60_000,
        });
        if (opened.kind !== "ready")
          throw new Error(`The test Orb did not start (${opened.kind}).`);
        const ran = await orb.exec("true", { timeoutMs: 30_000 });
        if (ran.exitCode !== 0)
          throw new Error("The test Orb could not run a command.");
      } finally {
        await orb.destroy().catch(() => undefined);
      }
    });
  let recipe: Promise<string> | undefined;
  return {
    providerId: "cloudflare",
    description:
      "Runs Orbs as Cloudflare Containers in your own account, which needs the Workers Paid plan. dx copies its Orb image there and deploys a small Orb Worker first, which takes a few minutes.",
    fields: [
      {
        id: "accountId",
        label: "Cloudflare account ID",
        secret: false,
        placeholder: "32 hexadecimal characters",
        help: "Shown on your account's Workers & Pages overview.",
      },
      {
        id: "apiToken",
        label: "API token",
        secret: true,
        help: "Create one with Workers Scripts Edit, Containers Edit, and Account Settings Read for this account.",
      },
    ],
    generatedFields: {
      workerSecret: () => randomHex(32),
      workerName: () => `dx-orb-${randomHex(6)}`,
    },
    recipe: () => {
      recipe ??= sha256(
        [
          accountOrbWorker,
          `${image.registry}/${image.repository}@${image.reference}`,
          ORB_COMPATIBILITY_DATE,
          String(ACCOUNT_ORB_PROTOCOL),
          JSON.stringify(CLOUDFLARE_ORB_PROFILES),
        ].join("\0"),
      ).then((digest) => digest.slice(0, 16));
      return recipe;
    },
    async start(raw) {
      const credentials = credentialsOf(raw);
      const me = await api(send, credentials, "/containers/me");
      if (me.status === 401 || me.status === 403) throw rejectedToken();
      if (me.status >= 400)
        throw new OrbProviderCredentialsRejected(
          "This account cannot run Cloudflare Containers. Containers needs the Workers Paid plan.",
        );
      const subdomain = await api<{ readonly subdomain?: string }>(
        send,
        credentials,
        "/workers/subdomain",
      );
      if (subdomain.status === 401 || subdomain.status === 403)
        throw rejectedToken();
      if (subdomain.result?.subdomain === undefined)
        throw new OrbProviderCredentialsRejected(
          "Choose a workers.dev subdomain for this account first (Workers & Pages → Overview).",
        );
      return preparing(credentials.accountId, {
        phase: "image",
        subdomain: subdomain.result.subdomain,
      });
    },
    async advance(raw, recipe, current) {
      const credentials = credentialsOf(raw);
      const state = stateOf(current);
      const account = credentials.accountId;
      const fail = (error: string) => failedPreparation(current, error);
      switch (state.phase) {
        case "image": {
          const copy = state.copy ?? (await startOciCopy(image, send));
          const login = await api<{
            readonly username?: string;
            readonly password?: string;
          }>(
            send,
            credentials,
            `/containers/registries/${REGISTRY}/credentials`,
            {
              method: "POST",
              body: JSON.stringify({
                expiration_minutes: 60,
                permissions: ["push", "pull"],
              }),
            },
          );
          if (login.status === 401 || login.status === 403)
            return fail(rejectedToken().message);
          if (
            login.result?.username === undefined ||
            login.result.password === undefined
          )
            throw failure("Cloudflare gave no registry credentials", login);
          const advanced = await advanceOciCopy(
            image,
            {
              registry: REGISTRY,
              repository: `${account}/dx-orb`,
              username: login.result.username,
              password: login.result.password,
            },
            copy,
            send,
          );
          if (!advanced.pushed)
            return preparing(account, { ...state, copy: advanced }, 0);
          return preparing(account, {
            phase: "image-preparation",
            subdomain: state.subdomain,
            image: `${REGISTRY}/${account}/dx-orb@${advanced.manifestDigest}`,
          });
        }
        case "image-preparation": {
          const prepared = await api<{
            readonly status?: string;
            readonly reason?: string;
          }>(send, credentials, "/containers/image-preparations", {
            method: "POST",
            body: JSON.stringify({ image: state.image }),
          });
          if (prepared.status === 403)
            return fail(
              "Cloudflare does not prepare container images for this account yet.",
            );
          if (prepared.result?.status === "error")
            return fail(
              `Cloudflare could not prepare the Orb image${prepared.result.reason === undefined ? "" : `: ${prepared.result.reason}`}.`,
            );
          if (prepared.result?.status !== "ready")
            return preparing(account, state, POLL_MS);
          return preparing(account, { ...state, phase: "worker" });
        }
        case "worker": {
          const scripts = await api<
            ReadonlyArray<{
              readonly id: string;
              readonly migration_tag?: string;
            }>
          >(send, credentials, "/workers/scripts");
          const existing = scripts.result?.find(
            ({ id }) => id === credentials.workerName,
          );
          const uploaded = await api(
            send,
            credentials,
            `/workers/scripts/${credentials.workerName}`,
            {
              method: "PUT",
              body: workerUpload(
                credentials,
                state.image as string,
                recipe,
                existing?.migration_tag !== ORB_MIGRATION_TAG,
              ),
            },
          );
          if (uploaded.status === 401 || uploaded.status === 403)
            return fail(rejectedToken().message);
          if (uploaded.status >= 400)
            throw failure("Cloudflare refused the Orb Worker", uploaded);
          return preparing(account, { ...state, phase: "application" });
        }
        case "application": {
          const namespaces = await api<
            ReadonlyArray<{
              readonly id: string;
              readonly class?: string;
              readonly script?: string;
            }>
          >(
            send,
            credentials,
            "/workers/durable_objects/namespaces?per_page=1000",
          );
          const namespace = namespaces.result?.find(
            (candidate) =>
              candidate.class === ORB_CONTAINER_CLASS &&
              candidate.script === credentials.workerName,
          );
          if (namespace === undefined)
            return preparing(account, state, POLL_MS);
          const application = await api(
            send,
            credentials,
            `/containers/applications/${namespace.id}`,
          );
          if (application.status === 404) {
            const created = await api(
              send,
              credentials,
              "/containers/applications",
              {
                method: "POST",
                body: JSON.stringify({
                  name: `${credentials.workerName}-orbcontainerobject`,
                  scheduling_policy: "durable_object",
                  durable_objects: { namespace_id: namespace.id },
                }),
              },
            );
            if (created.status >= 400)
              throw failure(
                "Cloudflare refused the Orb container application",
                created,
              );
          } else if (application.status >= 400)
            throw failure(
              "Cloudflare did not list the application",
              application,
            );
          return preparing(account, { ...state, phase: "route" });
        }
        case "route": {
          const routed = await api(
            send,
            credentials,
            `/workers/scripts/${credentials.workerName}/subdomain`,
            {
              method: "POST",
              body: JSON.stringify({ enabled: true, previews_enabled: false }),
            },
          );
          if (routed.status >= 400)
            throw failure("Cloudflare did not publish the Orb Worker", routed);
          return preparing(account, {
            ...state,
            phase: "health",
            endpoint: `https://${credentials.workerName}.${state.subdomain}.workers.dev/`,
            healthAttempts: 0,
          });
        }
        case "health": {
          // The upload this preparation made, not an earlier version the
          // route still serves.
          const healthy = await accountOrbHealth({
            endpoint: state.endpoint as string,
            secret: credentials.workerSecret,
            recipe,
            fetch: send,
          }).catch(() => false);
          if (healthy) return preparing(account, { ...state, phase: "probe" });
          const attempts = (state.healthAttempts ?? 0) + 1;
          // A new workers.dev route can take a minute to answer.
          if (attempts >= 36)
            return fail("The Orb Worker never answered on workers.dev.");
          return preparing(
            account,
            { ...state, healthAttempts: attempts },
            POLL_MS,
          );
        }
        case "probe": {
          await probe(state.endpoint as string, credentials.workerSecret);
          return {
            status: "ready",
            account,
            state: state as unknown as OrbPreparation["state"],
            progress: null,
            error: null,
          };
        }
      }
    },
    targets: (preparation) => {
      const endpoint = stateOf(preparation).endpoint;
      return preparation.status !== "ready" || endpoint === undefined
        ? undefined
        : new Map(CLOUDFLARE_ORB_PROFILES.map(({ id }) => [id, endpoint]));
    },
  };
};
