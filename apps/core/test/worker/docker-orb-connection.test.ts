import { env } from "cloudflare:test";
import { DOCKER_ORB_SIZES, Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import publicImage from "../../../../deploy/orb/public-image.json" with {
  type: "json",
};
import { makeDockerConnector } from "../../src/execution/docker/connector.js";
import { makeDockerExecutionProvider } from "../../src/execution/docker/provider.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import { advanceConnection } from "../../src/plugins/execution/preparation.js";
import type { ExecutionContext } from "../../src/plugins/execution/provider.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

const solo = "dk-orb-solo" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000007b1";
const threadId = "thr_00000000-0000-4000-8000-0000000007c1";
const timestamp = "2026-10-24T00:00:00.000Z";
/** The Docker account's UUID, which Docker Hub tokens carry as `sub`. */
const accountId = "5d1f0c2e-0000-4000-8000-0000000007a1";
const dockerId = "dx-dev";
/** Docker boots images only from Docker Hub, so the Orb image's mirror there. */
const orbImage = `docker.io/${publicImage.dockerHubRepository}@${publicImage.digest}`;
/** The registries Docker Cloud Sandboxes pulls from (checked 2026-10-27). */
const ALLOWED_REGISTRIES = [
  "docker.io",
  "registry-1.docker.io",
  "index.docker.io",
  "dhi.io",
];

/** No deployment provider: Docker runs only on a person's account. */
const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

type Status =
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

interface FakeSandbox {
  readonly uid: string;
  readonly request: Record<string, unknown>;
  readonly displayName: string;
  status: Status;
  version: number;
  failure?: string;
  readonly renewals: Array<string>;
  readonly lifecycle: Array<string>;
  readonly files: Map<string, { content: Uint8Array; writer: string }>;
  readonly execs: Array<{
    cmd: ReadonlyArray<string>;
    user: string;
    env?: Record<string, string>;
  }>;
}

interface World {
  /** Docker ID and personal access token pairs Docker Hub accepts. */
  readonly pats: Map<string, { dockerId: string; sub: string }>;
  /** Docker accounts without Cloud Sandboxes access. */
  readonly withoutCloud: Set<string>;
  readonly accessTokens: Map<string, string>;
  readonly endpointTokens: Map<string, string>;
  readonly sandboxes: Map<string, FakeSandbox>;
  readonly deleted: Array<FakeSandbox>;
  readonly idempotent: Map<string, string>;
  count: number;
  /** Tokens issued through `/v2/users/login`. */
  logins: number;
  /** Docker fails the image's boot with this reason. */
  failBoot: string | undefined;
  /** This account's backend does not renew deadlines. */
  renewUnimplemented: boolean;
  /**
   * Docker Hub's token exchange limits each IP address, and Cloudflare's
   * shared egress address is always over it (seen from a deployed Worker).
   */
  exchangeRateLimited: boolean;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const error = (status: number, code: string, message: string) =>
  json({ code, message }, status);

const base64url = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const encode = (text: string) => btoa(text);

const decode = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const etag = (sandbox: FakeSandbox) => `"${sandbox.uid}-${sandbox.version}"`;

const endpointHost = (uid: string) => `${uid}.endpoint.sandboxes.test`;

const sandboxJson = (sandbox: FakeSandbox) => ({
  name: `sandboxes/${sandbox.uid}`,
  uid: sandbox.uid,
  displayName: sandbox.displayName,
  core: {
    status: sandbox.status,
    etag: etag(sandbox),
    createdAt: timestamp,
    imageRef: sandbox.request.imageRef,
    resources: sandbox.request.resources,
    endpoint: {
      uri: `https://${endpointHost(sandbox.uid)}/`,
      protocol: "http",
      credentialAudience: `sandbox:${sandbox.uid}`,
      sandbox: `sandboxes/${sandbox.uid}`,
      sandboxUid: sandbox.uid,
      apiVersion: "v1",
      capabilities: ["exec", "readFile", "writeFile", "stat", "list"],
      authentication: {
        scheme: "scopedBearer",
        defaultTtl: "300s",
        maxTtl: "300s",
      },
    },
  },
  effectiveFeatures: {
    lifecycle: { stopMemoryOutcome: "discard" },
    outputRetention: {},
  },
  ...(sandbox.failure === undefined
    ? {}
    : { failure: { code: "failedPrecondition", message: sandbox.failure } }),
});

const changed = (sandbox: FakeSandbox, status: Status) => {
  sandbox.status = status;
  sandbox.version += 1;
};

/** What the exec'd bash script is: `timeout ... /bin/bash -c <script>`. */
const scriptOf = (cmd: ReadonlyArray<string>) => cmd.at(-1) ?? "";

/** One sandbox's endpoint: commands and files, as `user` or the file API. */
const sandboxEndpoint = async (
  world: World,
  sandbox: FakeSandbox,
  request: Request,
  url: URL,
) => {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
  // Only a credential issued for this sandbox is accepted here.
  if (bearer === undefined || world.endpointTokens.get(bearer) !== sandbox.uid)
    return error(401, "unauthenticated", "endpoint credential required");
  if (sandbox.status !== "running")
    return error(409, "failedPrecondition", "sandbox is not running");
  const path = url.searchParams.get("path") ?? "";
  if (url.pathname === "/v1/processes/exec") {
    const body = (await request.json()) as {
      cmd: Array<string>;
      user: string;
      env?: Record<string, string>;
    };
    sandbox.execs.push(body);
    const script = scriptOf(body.cmd);
    const ok = (stdout = "") =>
      json({ stdout: encode(stdout), stderr: "" }, 200);
    if (script.includes("supervisor.pid"))
      return json({
        stdout: "",
        stderr: "",
        // The image's entrypoint runs dx-orb-init, which writes its PID.
        exitCode: sandbox.request.imageRef === orbImage ? 0 : 1,
      });
    const small = /printf %s (\S+) \| base64 -d >'([^']+)'$/.exec(script);
    if (small !== null) {
      sandbox.files.set(small[2] as string, {
        content: decode(small[1] as string),
        writer: body.user,
      });
      return ok();
    }
    const staged = /cat (\/tmp\/dx-upload-\S+) >'([^']+)'/.exec(script);
    if (staged !== null) {
      const file = sandbox.files.get(staged[1] as string);
      if (file === undefined) return json({ exitCode: 1, stderr: "" });
      sandbox.files.set(staged[2] as string, {
        content: file.content,
        writer: body.user,
      });
      sandbox.files.delete(staged[1] as string);
      return ok();
    }
    const cwd = /^cd -- '([^']*)' \|\| exit 1\n/.exec(script)?.[1] ?? "~";
    return ok(`ran as ${body.user} in ${cwd}`);
  }
  if (url.pathname === "/v1/files/content" && request.method === "PUT") {
    sandbox.files.set(path, {
      content: new Uint8Array(await request.arrayBuffer()),
      writer: "file-api",
    });
    return json({ info: { path, mode: 420, type: "regular" } });
  }
  if (url.pathname === "/v1/files/content") {
    const file = sandbox.files.get(path);
    if (file === undefined) return error(404, "notFound", "no such file");
    return new Response(file.content as Uint8Array<ArrayBuffer>, {
      headers: { "content-length": String(file.content.byteLength) },
    });
  }
  if (url.pathname === "/v1/files/stat") {
    if (sandbox.files.has(path))
      return json({ info: { path, isDir: false, type: "regular" } });
    if ([...sandbox.files.keys()].some((file) => file.startsWith(`${path}/`)))
      return json({ info: { path, isDir: true, type: "directory" } });
    return error(404, "notFound", "no such path");
  }
  if (url.pathname === "/v1/files") {
    const names = new Set(
      [...sandbox.files.keys()]
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1).split("/")[0]),
    );
    return json({
      entries: [...names].map((name) => ({ path: `${path}/${name}` })),
      nextPageToken: "",
    });
  }
  return new Response(null, { status: 599 });
};

/**
 * Docker Hub's token exchange, the Sandboxes management API, and each
 * sandbox's endpoint, in memory, at the HTTP boundary.
 */
const fakeDocker =
  (world: World) =>
  async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const issue = (identity: { dockerId: string; sub: string }) => {
      world.count += 1;
      const token = `${base64url({ alg: "RS256" })}.${base64url({
        sub: identity.sub,
        exp: Math.floor(Date.now() / 1_000) + 600,
        "https://hub.docker.com": { username: identity.dockerId },
      })}.sig${world.count}`;
      world.accessTokens.set(token, identity.sub);
      return token;
    };
    if (url.host === "hub.docker.com" && url.pathname === "/v2/auth/token") {
      if (world.exchangeRateLimited)
        return new Response(
          JSON.stringify({ detail: "Rate limit exceeded", error: false }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "60",
              "x-ratelimit-limit": "180",
              "x-ratelimit-remaining": "-534",
            },
          },
        );
      const body = (await request.json()) as {
        identifier: string;
        secret: string;
      };
      const identity = world.pats.get(`${body.identifier}:${body.secret}`);
      if (identity === undefined)
        return json({ detail: "incorrect username or password" }, 401);
      return json({ access_token: issue(identity) });
    }
    if (url.host === "hub.docker.com" && url.pathname === "/v2/users/login") {
      const body = (await request.json()) as {
        username: string;
        password: string;
      };
      const identity = world.pats.get(`${body.username}:${body.password}`);
      if (identity === undefined)
        return json({ detail: "Incorrect authentication credentials" }, 401);
      world.logins += 1;
      return json({ token: issue(identity), refresh_token: "refresh" });
    }
    const uidOfEndpoint = /^(.+)\.endpoint\.sandboxes\.test$/.exec(
      url.host,
    )?.[1];
    if (uidOfEndpoint !== undefined) {
      const sandbox = world.sandboxes.get(uidOfEndpoint);
      if (sandbox === undefined) return error(404, "notFound", "no sandbox");
      return sandboxEndpoint(world, sandbox, request, url);
    }
    if (
      url.host !== "connect.docker.com" ||
      !url.pathname.startsWith("/sandboxes/v1/")
    )
      return new Response(null, { status: 599 });
    const bearer = request.headers
      .get("authorization")
      ?.replace(/^Bearer /, "");
    const account =
      bearer === undefined ? undefined : world.accessTokens.get(bearer);
    if (account === undefined)
      return error(401, "unauthenticated", "invalid access token");
    if (world.withoutCloud.has(account))
      return error(403, "permissionDenied", "Cloud Sandboxes access required");
    const path = url.pathname.slice("/sandboxes".length);
    const body =
      request.method === "POST" || request.method === "PATCH"
        ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
        : undefined;
    if (path === "/v1/sandboxes" && request.method === "GET") {
      const filter = url.searchParams.get("filter");
      const name = filter?.replace(/^display_name=/, "");
      return json({
        sandboxes: [...world.sandboxes.values()]
          .filter(
            ({ displayName }) => name === undefined || displayName === name,
          )
          .map(sandboxJson),
        nextPageToken: "",
      });
    }
    if (path === "/v1/sandboxes" && request.method === "POST") {
      const key = request.headers.get("idempotency-key");
      const replay = key === null ? undefined : world.idempotent.get(key);
      if (replay !== undefined)
        return json(
          sandboxJson(world.sandboxes.get(replay) as FakeSandbox),
          201,
        );
      const request_ = body as Record<string, unknown>;
      const registry = String(request_.imageRef).split("/")[0] as string;
      if (!ALLOWED_REGISTRIES.includes(registry))
        return error(
          400,
          "invalidArgument",
          `invalid inline parameters: image registry not allowed: ${registry} (allowed registries: ${ALLOWED_REGISTRIES.join(", ")})`,
        );
      const prefix = request_.displayNamePrefix as string | undefined;
      world.count += 1;
      const displayName =
        (request_.displayName as string | undefined) ??
        `${prefix ?? "sbx-"}${world.count}`;
      if (
        [...world.sandboxes.values()].some(
          (sandbox) => sandbox.displayName === displayName,
        )
      )
        return error(409, "alreadyExists", "display name taken");
      const sandbox: FakeSandbox = {
        uid: `sbx${world.count}`,
        request: request_,
        displayName,
        status: "creating",
        version: 1,
        renewals: [],
        lifecycle: [],
        files: new Map(),
        execs: [],
      };
      world.sandboxes.set(sandbox.uid, sandbox);
      if (key !== null) world.idempotent.set(key, sandbox.uid);
      return json(sandboxJson(sandbox), 201);
    }
    const match = /^\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(path);
    const sandbox =
      match === null
        ? undefined
        : world.sandboxes.get(decodeURIComponent(match[1] as string));
    if (match === null || sandbox === undefined)
      return error(404, "notFound", "sandbox not found");
    const action = match[2] ?? "";
    const precondition = () => {
      const ifMatch = request.headers.get("if-match");
      if (ifMatch === null) return error(428, "failedPrecondition", "etag");
      if (ifMatch !== etag(sandbox))
        return error(412, "failedPrecondition", "etag_mismatch");
      return undefined;
    };
    if (action === "" && request.method === "GET") {
      const shown = sandboxJson(sandbox);
      // Each transition has finished by the time anyone looks again.
      if (sandbox.status === "creating" || sandbox.status === "starting") {
        if (world.failBoot !== undefined) {
          sandbox.failure = world.failBoot;
          changed(sandbox, "failed");
        } else changed(sandbox, "running");
      } else if (sandbox.status === "stopping") changed(sandbox, "stopped");
      return json(shown);
    }
    if (action === "" && request.method === "DELETE") {
      const refused = precondition();
      if (refused !== undefined) return refused;
      world.sandboxes.delete(sandbox.uid);
      world.deleted.push(sandbox);
      return new Response(null, { status: 204 });
    }
    if (action === "/endpoint-credentials") {
      world.count += 1;
      const token = `ep-${sandbox.uid}-${world.count}`;
      world.endpointTokens.set(token, sandbox.uid);
      return json({
        token,
        expireTime: new Date(Date.now() + 300_000).toISOString(),
        permissions: body?.permissions,
        sandbox: `sandboxes/${sandbox.uid}`,
        audience: `sandbox:${sandbox.uid}`,
      });
    }
    if (action === "/renew-timeout") {
      if (world.renewUnimplemented)
        return error(
          501,
          "unimplemented",
          "This operation is not available on this service.",
        );
      sandbox.renewals.push(body?.timeout as string);
      return json(sandboxJson(sandbox));
    }
    if (action === "/stop" || action === "/start") {
      const refused = precondition();
      if (refused !== undefined) return refused;
      const from = action === "/stop" ? "running" : "stopped";
      if (sandbox.status !== from)
        return error(409, "failedPrecondition", `sandbox is ${sandbox.status}`);
      sandbox.lifecycle.push(action.slice(1));
      changed(sandbox, action === "/stop" ? "stopping" : "starting");
      return json(sandboxJson(sandbox), 202);
    }
    return new Response(null, { status: 599 });
  };

let world: World;
let connectors: OrbProviderConnectors;

const app = () => {
  const router = new Hono<AppEnv>();
  router.use("*", requestId);
  router.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId: solo,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  router.route(
    "/personal/orb-providers",
    makePersonalOrbProviderRoutes({ connectors }),
  );
  router.onError(errorHandler);
  return router;
};

const call = async (
  path: string,
  method: "GET" | "PUT" = "GET",
  body?: unknown,
) => {
  const response = await app().request(
    `/personal/orb-providers${path}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    bindings,
  );
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  return { status: response.status, body: (await response.json()) as any };
};

const dockerOf = (data: {
  readonly providers: ReadonlyArray<{ readonly id: string }>;
}) =>
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  data.providers.find(({ id }) => id === "docker") as any;

const key = {
  scope: "personal",
  targetId: solo,
  providerId: "docker",
} as const;

const prepare = async () => {
  const steps: Array<string> = [];
  for (let step = 0; step < 40; step += 1) {
    const outcome = await advanceConnection(bindings, env.DB, key, connectors);
    steps.push(
      dockerOf((await call("")).body.data).connection?.progress?.step ?? "done",
    );
    if (outcome.nextStepInMs === undefined) return steps;
  }
  throw new Error("Preparation never finished.");
};

const connect = (accessToken: string) =>
  call("/docker/connection", "PUT", {
    credentials: { dockerId, accessToken },
  });

beforeEach(async () => {
  world = {
    pats: new Map([
      [`${dockerId}:dckr_pat_one`, { dockerId, sub: accountId }],
      [`${dockerId}:dckr_pat_two`, { dockerId, sub: accountId }],
      ["registry-only:dckr_pat_reg", { dockerId: "registry-only", sub: "u-2" }],
    ]),
    withoutCloud: new Set(["u-2"]),
    accessTokens: new Map(),
    endpointTokens: new Map(),
    sandboxes: new Map(),
    deleted: [],
    idempotent: new Map(),
    count: 0,
    logins: 0,
    failBoot: undefined,
    renewUnimplemented: false,
    exchangeRateLimited: false,
  };
  const connector = makeDockerConnector({
    fetch: fakeDocker(world) as typeof fetch,
  });
  if (connector === undefined) throw new Error("No public Orb image.");
  connectors = { docker: connector };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(solo, solo, `${solo}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Docker project', 'dk.medium', ?, ?)`,
    ).bind(project, solo, timestamp, timestamp),
  ]);
});

describe("Docker Cloud Sandboxes in a person's own account", () => {
  it("tests the public Orb image on a test Orb, then runs a Thread's sandbox through its deadline, pause, wake, archive, and delete", async () => {
    const listed = await call("");
    expect(dockerOf(listed.body.data)).toMatchObject({
      deployment: false,
      connection: null,
      pauseResume: "filesystem",
      fields: [
        { id: "dockerId", secret: false },
        { id: "accessToken", secret: true },
      ],
    });
    expect(
      dockerOf(listed.body.data).sizes.map(({ id }: { id: string }) => id),
    ).toEqual(DOCKER_ORB_SIZES.map(({ id }) => id));

    // A refused token fails in the save request, and so does a token for
    // an account without Cloud Sandboxes.
    const refused = await connect("dckr_pat_wrong");
    expect(refused.status).toBe(400);
    expect(refused.body.data.detail).toBe(
      "Docker rejected this Docker ID and access token.",
    );
    const registryOnly = await call("/docker/connection", "PUT", {
      credentials: { dockerId: "registry-only", accessToken: "dckr_pat_reg" },
    });
    expect(registryOnly.status).toBe(400);
    expect(registryOnly.body.data.detail).toMatch(
      /^This account cannot use Cloud Sandboxes\./,
    );
    expect(world.sandboxes.size).toBe(0);

    const saved = await connect("dckr_pat_one");
    expect(saved.status).toBe(200);
    expect(dockerOf(saved.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
    });

    const steps = [...new Set(await prepare())];
    expect(steps).toEqual([
      "Starting a test Orb in your Docker account",
      "Checking the test Orb",
      "Pausing the test Orb",
      "Resuming the test Orb",
      "done",
    ]);

    // The test Orb booted the public Orb image on x86 with its own
    // entrypoint, ran as `user`, had its deadline moved, stopped and
    // started, and is gone. It deletes itself if preparation stops.
    expect(world.sandboxes.size).toBe(0);
    const probe = world.deleted.find(({ displayName }) =>
      displayName.startsWith("dx-orb-probe-"),
    );
    expect(probe?.request).toMatchObject({
      imageRef: orbImage,
      platform: { os: "linux", architecture: "amd64" },
      resources: { cpus: 2, memoryMib: 4096 },
      startupExecution: { rawImage: {} },
      features: {
        timeouts: { timeout: "1800s", onTimeout: "delete", autoResume: false },
      },
    });
    expect(probe?.execs.map(({ user }) => user)).toEqual(["user", "user"]);
    expect(probe?.renewals).toEqual(["1800s"]);
    expect(probe?.lifecycle).toEqual(["stop", "start"]);

    const ready = await call("");
    expect(dockerOf(ready.body.data).connection).toMatchObject({
      status: "ready",
      account: accountId,
    });
    expect(ready.body.data.resolved).toEqual([
      {
        providerId: "docker",
        scope: "personal",
        account: accountId,
        status: "ready",
        unavailableSizes: [],
      },
    ]);

    // A Thread on dk.medium pins the image the test Orb booted.
    await env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(threadId, project, solo, timestamp, timestamp)
      .run();
    const pin = await resolveThreadExecutionPin({
      db: env.DB,
      bindings,
      userId: solo,
      projectId: project,
      runnerProfileId: undefined,
      connectors,
    });
    expect(pin).toEqual({
      provider: "docker",
      runnerProfileId: "dk.medium",
      credentialScope: "personal",
      credentialOwnerId: solo,
      credentialAccount: accountId,
      providerTemplate: orbImage,
    });
    await env.DB.prepare(
      `UPDATE execution_workspace
          SET provider = ?, runner_profile_id = ?, account_scope = ?,
              account_owner_id = ?, provider_account = ?, provider_template = ?
        WHERE thread_id = ?`,
    )
      .bind(
        pin?.provider,
        pin?.runnerProfileId,
        pin?.credentialScope,
        pin?.credentialOwnerId,
        pin?.credentialAccount,
        pin?.providerTemplate,
        threadId,
      )
      .run();
    const target = await Effect.runPromise(
      resolveExecutionTarget(bindings, threadId, { admission: false }),
    );
    expect(target.profile).toMatchObject({
      adapter: "docker",
      resources: { cpuCores: 4, memoryMb: 8192 },
      image: orbImage,
    });
    if (target.credential.scope !== "personal") throw new Error("no account");
    expect(Redacted.value(target.credential.credentials)).toEqual({
      dockerId,
      accessToken: "dckr_pat_one",
    });

    // The provider creates the Thread's sandbox from the pinned image at
    // the size's CPU and memory, with a stop deadline of one idle window,
    // and records it in D1.
    const provider = makeDockerExecutionProvider({
      fetch: fakeDocker(world) as typeof fetch,
    });
    const context: ExecutionContext = {
      account: { scope: "personal", userId: solo, providerAccount: accountId },
      credentials: target.credential.credentials,
      profile: target.profile,
    };
    const authorize = async () => {};
    const handle = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    expect(world.sandboxes.size).toBe(1);
    const sandbox = [...world.sandboxes.values()][0] as FakeSandbox;
    expect(sandbox).toMatchObject({
      displayName: `dx-${threadId}`,
      status: "running",
    });
    expect(sandbox.request).toMatchObject({
      imageRef: orbImage,
      platform: { os: "linux", architecture: "amd64" },
      resources: { cpus: 4, memoryMib: 8192 },
      startupExecution: { rawImage: {} },
      features: {
        timeouts: { timeout: "300s", onTimeout: "stop", autoResume: false },
      },
      labels: { dxThread: threadId },
    });
    expect(handle.processesStartedAt).toBeTypeOf("number");
    const record = async () =>
      env.DB.prepare(
        "SELECT provider, state, provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
      )
        .bind(threadId)
        .first();
    expect(await record()).toEqual({
      provider: "docker",
      state: "initialized",
      provider_sandbox_id: sandbox.uid,
    });

    // Commands run as the workspace account, in their directory, under
    // their own time limit; writes of any size land as `user`.
    const ran = await handle.guest.commands.run("pwd", {
      cwd: "/home/user/workspace",
      timeoutMs: 60_000,
    });
    expect(ran).toMatchObject({
      exitCode: 0,
      stdout: "ran as user in /home/user/workspace",
    });
    expect(sandbox.execs.at(-1)?.cmd.slice(0, 5)).toEqual([
      "timeout",
      "--kill-after=5",
      "60",
      "/bin/bash",
      "-c",
    ]);
    await handle.guest.files.write("/home/user/note.txt", "hello");
    const large = "x".repeat(100_000);
    await handle.guest.files.write("/home/user/large.txt", large);
    expect(
      new TextDecoder().decode(
        sandbox.files.get("/home/user/note.txt")?.content,
      ),
    ).toBe("hello");
    expect(sandbox.files.get("/home/user/large.txt")).toMatchObject({
      writer: "user",
    });
    expect(
      new TextDecoder().decode(
        sandbox.files.get("/home/user/large.txt")?.content,
      ),
    ).toBe(large);
    expect(sandbox.files.get("/home/user/note.txt")?.writer).toBe("user");
    expect(
      [...sandbox.files.keys()].some((path) => path.startsWith("/tmp/")),
    ).toBe(false);
    expect(new Set(sandbox.execs.map(({ user }) => user))).toEqual(
      new Set(["user"]),
    );
    // The agent's sandbox reads through the file API.
    const agent = await handle.sandbox("/home/user");
    expect(await agent.readFile("/home/user/note.txt")).toBe("hello");

    // Core moves Docker's deadline forward while the Orb is in use.
    await handle.setIdleDeadline(300_000);
    expect(sandbox.renewals).toEqual(["300s"]);

    // Idle: the deadline lapses and Docker stops the sandbox. The next
    // activation sees it paused, starts it under its current ETag, and
    // reports that its processes restarted.
    changed(sandbox, "stopped");
    const residency: Array<string> = [];
    const woken = await provider.workspace.create(
      context,
      { threadId: threadId as never },
      {
        authorize,
        observeResidency: (seen) => {
          residency.push(seen);
        },
      },
    );
    expect(residency).toEqual(["paused"]);
    expect(sandbox).toMatchObject({ status: "running" });
    expect(sandbox.lifecycle).toEqual(["start"]);
    expect(woken.processesStartedAt).toBeTypeOf("number");
    // A running sandbox is reached as it is, and a connect never creates.
    const reached = await provider.workspace.connect(
      context,
      { threadId: threadId as never },
      { authorize },
    );
    expect(reached.processesStartedAt).toBeUndefined();
    expect(world.sandboxes.size).toBe(1);

    // Archiving stops the sandbox; deleting the Thread deletes it.
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "archive",
    );
    expect(sandbox.lifecycle).toEqual(["start", "stop"]);
    await provider.workspace.release(
      context,
      { threadId: threadId as never },
      "destroy",
    );
    expect(world.sandboxes.size).toBe(0);
    expect(await record()).toMatchObject({ state: "lost" });

    // A new token for the same account keeps the connection's account.
    const rotating = await connect("dckr_pat_two");
    expect(dockerOf(rotating.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
      updating: true,
    });
    await prepare();
    expect(dockerOf((await call("")).body.data).connection).toMatchObject({
      status: "ready",
      updating: false,
    });
  }, 60_000);

  it("fails with Docker's reason and leaves no test Orb when the image does not boot", async () => {
    world.failBoot = "image pull failed: unauthorized";
    expect((await connect("dckr_pat_one")).status).toBe(200);
    await prepare();
    expect(dockerOf((await call("")).body.data).connection).toMatchObject({
      status: "failed",
      error:
        "Docker could not start the Orb image: image pull failed: unauthorized",
    });
    expect(world.sandboxes.size).toBe(0);
  }, 30_000);

  it("fails when the account cannot move a sandbox's deadline, which idle pause needs", async () => {
    world.renewUnimplemented = true;
    expect((await connect("dckr_pat_one")).status).toBe(200);
    await prepare();
    expect(dockerOf((await call("")).body.data).connection).toMatchObject({
      status: "failed",
      error:
        "Docker would not move the test Orb's deadline, which dx needs to pause idle Orbs.",
    });
    expect(world.sandboxes.size).toBe(0);
  }, 30_000);

  it("fails with Docker's reason, without retrying, when Docker refuses the image's registry", async () => {
    const connector = makeDockerConnector({
      fetch: fakeDocker(world) as typeof fetch,
      image: `ghcr.io/dxcode-dev/dx-orb@${publicImage.digest}`,
    });
    if (connector === undefined) throw new Error("No Orb image.");
    connectors = { docker: connector };
    expect((await connect("dckr_pat_one")).status).toBe(200);
    await prepare();
    expect(dockerOf((await call("")).body.data).connection).toMatchObject({
      status: "failed",
      error:
        "Docker refused the Orb image: invalid inline parameters: image registry not allowed: ghcr.io (allowed registries: docker.io, registry-1.docker.io, index.docker.io, dhi.io)",
    });
    expect(world.sandboxes.size).toBe(0);
  }, 30_000);

  it("signs in through Docker Hub's login when its token exchange rate-limits Cloudflare's shared address", async () => {
    world.exchangeRateLimited = true;
    const refused = await connect("dckr_pat_wrong");
    expect(refused.status).toBe(400);
    expect(refused.body.data.detail).toBe(
      "Docker rejected this Docker ID and access token.",
    );
    expect((await connect("dckr_pat_one")).status).toBe(200);
    await prepare();
    expect(dockerOf((await call("")).body.data).connection).toMatchObject({
      account: accountId,
      status: "ready",
    });
    expect(world.logins).toBeGreaterThan(0);
    expect(world.sandboxes.size).toBe(0);
  }, 30_000);
});
