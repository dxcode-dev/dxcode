import { env } from "cloudflare:test";
import { CLOUDFLARE_ORB_PROFILES, Principal, type UserId } from "@dx/domain";
import { Effect, Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { makeCloudflareConnector } from "../../src/execution/cloudflare/connector.js";
import { resolveExecutionTarget } from "../../src/execution/runner-profiles/execution.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import type { OrbProviderConnectors } from "../../src/plugins/execution/connector.js";
import { makePersonalOrbProviderRoutes } from "../../src/plugins/execution/orb-provider-routes.js";
import { resolveThreadExecutionPin } from "../../src/plugins/execution/orb-providers.js";
import { advanceConnection } from "../../src/plugins/execution/preparation.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

const solo = "cf-orb-solo" as UserId;
const project = "prj_00000000-0000-4000-8000-0000000005b1";
const timestamp = "2026-10-22T00:00:00.000Z";
const accountId = "a".repeat(32);

/** No deployment provider: Cloudflare runs only on a person's account. */
const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const digestOf = async (data: Uint8Array | string) =>
  `sha256:${hex(
    await crypto.subtle.digest(
      "SHA-256",
      typeof data === "string" ? new TextEncoder().encode(data) : data,
    ),
  )}`;

/** The public Orb image: an index naming one linux/amd64 manifest. */
const layer = new TextEncoder().encode("orb layer bytes ".repeat(64));
const config = new TextEncoder().encode('{"architecture":"amd64"}');
const image = async () => {
  const blobs = new Map<string, Uint8Array>([
    [await digestOf(config), config],
    [await digestOf(layer), layer],
  ]);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: await digestOf(config),
      size: config.byteLength,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: await digestOf(layer),
        size: layer.byteLength,
      },
    ],
  });
  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: await digestOf(manifest),
        platform: { os: "linux", architecture: "amd64" },
      },
    ],
  });
  return { blobs, manifest, index, manifestDigest: await digestOf(manifest) };
};

interface World {
  readonly uploads: Map<string, Array<Uint8Array>>;
  readonly registry: Map<string, Uint8Array>;
  readonly manifests: Map<string, string>;
  scripts: Array<{ id: string; migration_tag?: string }>;
  readonly metadata: Array<Record<string, unknown>>;
  application: boolean;
  preparations: number;
  readonly calls: Array<string>;
  rejectToken: boolean;
  healthChecks: number;
  servedRecipe: string | undefined;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** GHCR, the Cloudflare API, and registry.cloudflare.com, in memory. */
const fakeFetch =
  (world: World, published: Awaited<ReturnType<typeof image>>) =>
  async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    world.calls.push(`${request.method} ${url.host}${url.pathname}`);
    if (url.host === "ghcr.io") {
      if (url.pathname === "/token") return json({ token: "pull-token" });
      if (request.headers.get("authorization") !== "Bearer pull-token")
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:dxcode-dev/dx-orb:pull"',
          },
        });
      if (url.pathname.endsWith("/manifests/latest"))
        return new Response(published.index, {
          headers: {
            "content-type": "application/vnd.oci.image.index.v1+json",
          },
        });
      if (url.pathname.endsWith(`/manifests/${published.manifestDigest}`))
        return new Response(published.manifest);
      const blob = /\/blobs\/(sha256:[a-f0-9]+)$/.exec(url.pathname)?.[1];
      if (blob !== undefined)
        return new Response(null, {
          status: 307,
          headers: { location: `https://storage.test/${blob}` },
        });
    }
    if (url.host === "storage.test") {
      const bytes = published.blobs.get(url.pathname.slice(1));
      const range = /bytes=(\d+)-(\d+)/.exec(
        request.headers.get("range") ?? "",
      );
      if (bytes === undefined || range === null)
        return new Response(null, { status: 404 });
      return new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1), {
        status: 206,
      });
    }
    if (url.host === "registry.cloudflare.com") {
      if (!request.headers.get("authorization")?.startsWith("Basic "))
        return new Response(null, { status: 401 });
      const blob = /\/blobs\/(sha256:[a-f0-9]+)$/.exec(url.pathname)?.[1];
      if (request.method === "HEAD" && blob !== undefined)
        return new Response(null, {
          status: world.registry.has(blob) ? 200 : 404,
        });
      if (request.method === "POST" && url.pathname.endsWith("/uploads/")) {
        const id = crypto.randomUUID();
        world.uploads.set(id, []);
        return new Response(null, {
          status: 202,
          headers: { location: `/v2/${accountId}/dx-orb/blobs/uploads/${id}` },
        });
      }
      const upload = /\/uploads\/([^/]+)$/.exec(url.pathname)?.[1];
      if (upload !== undefined && request.method === "PATCH") {
        world.uploads
          .get(upload)
          ?.push(new Uint8Array(await request.arrayBuffer()));
        return new Response(null, {
          status: 202,
          headers: { location: url.pathname },
        });
      }
      if (upload !== undefined && request.method === "PUT") {
        const parts = world.uploads.get(upload) ?? [];
        const bytes = new Uint8Array(
          parts.reduce((total, part) => total + part.byteLength, 0),
        );
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        const digest = url.searchParams.get("digest") ?? "";
        if ((await digestOf(bytes)) !== digest)
          return new Response(null, { status: 400 });
        world.registry.set(digest, bytes);
        return new Response(null, { status: 201 });
      }
      const manifest = /\/manifests\/(sha256:[a-f0-9]+)$/.exec(
        url.pathname,
      )?.[1];
      if (manifest !== undefined && request.method === "PUT") {
        const text = await request.text();
        if ((await digestOf(text)) !== manifest)
          return new Response(null, { status: 400 });
        world.manifests.set(manifest, text);
        return new Response(null, { status: 201 });
      }
    }
    if (url.host === "api.cloudflare.com") {
      if (world.rejectToken) return json({ errors: [] }, 403);
      const path = url.pathname.replace(`/client/v4/accounts/${accountId}`, "");
      if (path === "/containers/me") return json({ result: {} });
      if (path === "/workers/subdomain")
        return json({ result: { subdomain: "acct" } });
      if (path === "/containers/registries/registry.cloudflare.com/credentials")
        return json({ result: { username: "v1", password: "push" } }, 201);
      if (path === "/containers/image-preparations") {
        world.preparations += 1;
        const { image: prepared } = (await request.json()) as {
          image: string;
        };
        expect(prepared).toBe(
          `registry.cloudflare.com/${accountId}/dx-orb@${published.manifestDigest}`,
        );
        return json(
          { result: { status: world.preparations > 1 ? "ready" : "pending" } },
          world.preparations > 1 ? 200 : 202,
        );
      }
      if (path === "/workers/scripts" && request.method === "GET")
        return json({ result: world.scripts });
      const script = /^\/workers\/scripts\/([^/]+)$/.exec(path)?.[1];
      if (script !== undefined && request.method === "PUT") {
        const form = await request.formData();
        const metadata = JSON.parse(
          await (form.get("metadata") as File).text(),
        ) as Record<string, unknown>;
        world.metadata.push(metadata);
        expect(
          await (form.get("account-orb-worker.js") as File).text(),
        ).toContain("OrbContainerObject");
        world.scripts = [{ id: script, migration_tag: "v1-orb-container" }];
        return json({ result: { id: script } });
      }
      if (path === "/workers/durable_objects/namespaces")
        return json({
          result: world.scripts.map(({ id }) => ({
            id: "namespace-1",
            class: "OrbContainerObject",
            script: id,
          })),
        });
      if (path === "/containers/applications/namespace-1")
        return world.application
          ? json({ result: {} })
          : json({ errors: [] }, 404);
      if (path === "/containers/applications" && request.method === "POST") {
        world.application = true;
        return json({ result: {} });
      }
      if (/^\/workers\/scripts\/[^/]+\/subdomain$/.test(path))
        return json({ result: { enabled: true } });
    }
    // The route serves the latest upload once it has propagated: the first
    // health check after an upload still reaches the earlier version.
    if (url.host.endsWith(".acct.workers.dev") && url.pathname === "/health") {
      const latest = world.metadata.at(-1) as
        | { readonly bindings: ReadonlyArray<{ name: string; text?: string }> }
        | undefined;
      const uploaded = latest?.bindings.find(
        ({ name }) => name === "DX_ORB_RECIPE",
      )?.text;
      const served =
        world.healthChecks++ % 2 === 0 ? world.servedRecipe : uploaded;
      world.servedRecipe = uploaded;
      return json({ ok: true, protocol: 1, recipe: served ?? null });
    }
    return new Response(null, { status: 599 });
  };

let world: World;
let connectors: OrbProviderConnectors;
const probes: Array<{ endpoint: string; secret: string }> = [];

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

const cloudflareOf = (data: {
  readonly providers: ReadonlyArray<{ readonly id: string }>;
}) =>
  // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
  data.providers.find(({ id }) => id === "cloudflare") as any;

const key = {
  scope: "personal",
  targetId: solo,
  providerId: "cloudflare",
} as const;

const prepare = async () => {
  const steps: Array<string> = [];
  for (let step = 0; step < 40; step += 1) {
    const outcome = await advanceConnection(bindings, env.DB, key, connectors);
    steps.push(
      cloudflareOf((await call("")).body.data).connection?.progress?.step ??
        "done",
    );
    if (outcome.nextStepInMs === undefined) return steps;
  }
  throw new Error("Preparation never finished.");
};

beforeEach(async () => {
  const published = await image();
  world = {
    uploads: new Map(),
    registry: new Map(),
    manifests: new Map(),
    scripts: [],
    metadata: [],
    application: false,
    preparations: 0,
    calls: [],
    rejectToken: false,
    healthChecks: 0,
    servedRecipe: undefined,
  };
  probes.length = 0;
  const connector = makeCloudflareConnector({
    fetch: fakeFetch(world, published) as typeof fetch,
    image: {
      registry: "ghcr.io",
      repository: "dxcode-dev/dx-orb",
      reference: "latest",
    },
    probe: async (endpoint, secret) => {
      probes.push({ endpoint, secret });
    },
  });
  if (connector === undefined) throw new Error("no Cloudflare connector");
  connectors = { cloudflare: connector };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(solo, solo, `${solo}@example.com`, 1, 1),
    env.DB.prepare(
      `INSERT INTO projects (id, owner_user_id, workspace_id, name, runner_profile_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'Cloudflare project', 'cf.standard-2', ?, ?)`,
    ).bind(project, solo, timestamp, timestamp),
  ]);
});

describe("Cloudflare Containers in a person's own account", () => {
  it("copies the Orb image, deploys the Orb Worker, tests it, and pins Threads to it", async () => {
    const listed = await call("");
    expect(cloudflareOf(listed.body.data)).toMatchObject({
      deployment: false,
      connection: null,
      fields: [
        { id: "accountId", secret: false },
        { id: "apiToken", secret: true },
      ],
    });
    expect(
      cloudflareOf(listed.body.data).sizes.map(({ id }: { id: string }) => id),
    ).toEqual(CLOUDFLARE_ORB_PROFILES.map(({ id }) => id));

    // A refused token fails in the save request, with what it needs.
    world.rejectToken = true;
    const refused = await call("/cloudflare/connection", "PUT", {
      credentials: { accountId, apiToken: "token-1" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.data.detail).toContain("Containers Edit");
    world.rejectToken = false;

    const saved = await call("/cloudflare/connection", "PUT", {
      credentials: { accountId, apiToken: "token-1" },
    });
    expect(saved.status).toBe(200);
    expect(cloudflareOf(saved.body.data).connection).toMatchObject({
      account: accountId,
      status: "preparing",
      progress: {
        step: "Copying the Orb image into your Cloudflare account",
        done: 0,
      },
    });

    // Each step the settings page shows, in order, until ready.
    const steps = [...new Set(await prepare())];
    expect(steps).toEqual([
      "Cloudflare is preparing the Orb image",
      "Deploying the Orb Worker",
      "Creating the Orb container application",
      "Publishing the Orb Worker on workers.dev",
      "Waiting for the Orb Worker to answer",
      "Starting a test Orb",
      "done",
    ]);

    // The image arrived byte for byte, under the digest the Worker names.
    const published = await image();
    for (const [digest, bytes] of published.blobs)
      expect(world.registry.get(digest)).toEqual(bytes);
    expect(world.manifests.get(published.manifestDigest)).toBe(
      published.manifest,
    );
    const metadata = world.metadata[0] as {
      readonly containers: ReadonlyArray<{
        readonly class_name: string;
        readonly images: Record<string, string>;
      }>;
      readonly bindings: ReadonlyArray<{
        readonly type: string;
        readonly name: string;
      }>;
      readonly migrations?: unknown;
    };
    expect(metadata.containers).toEqual([
      expect.objectContaining({
        class_name: "OrbContainerObject",
        images: {
          orb: `registry.cloudflare.com/${accountId}/dx-orb@${published.manifestDigest}`,
        },
      }),
    ]);
    expect(
      metadata.bindings.map(({ type, name }) => `${type}:${name}`),
    ).toEqual([
      "durable_object_namespace:ORB_CONTAINER",
      "secret_text:DX_ORB_WORKER_SECRET",
      "plain_text:DX_ORB_RECIPE",
    ]);
    expect(metadata.migrations).toEqual({
      new_tag: "v1-orb-container",
      new_sqlite_classes: ["OrbContainerObject"],
    });
    expect(world.application).toBe(true);
    // The test Orb ran through the published Worker with its secret.
    expect(probes).toHaveLength(1);
    expect(probes[0]?.endpoint).toMatch(
      /^https:\/\/dx-orb-[a-f0-9]{12}\.acct\.workers\.dev\/$/,
    );

    const ready = await call("");
    expect(cloudflareOf(ready.body.data).connection).toMatchObject({
      status: "ready",
      account: accountId,
    });
    expect(ready.body.data.resolved).toEqual([
      {
        providerId: "cloudflare",
        scope: "personal",
        account: accountId,
        status: "ready",
      },
    ]);

    // A Thread pins the Worker and runs on the account's credentials.
    const threadId = "thr_00000000-0000-4000-8000-0000000005c1";
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
      provider: "cloudflare",
      runnerProfileId: "cf.standard-2",
      credentialScope: "personal",
      credentialOwnerId: solo,
      credentialAccount: accountId,
      providerTemplate: probes[0]?.endpoint,
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
      adapter: "cloudflare",
      instance: "standard-2",
      endpoint: probes[0]?.endpoint,
    });
    if (target.credential.scope !== "personal") throw new Error("no account");
    const credentials = Redacted.value(target.credential.credentials);
    expect(credentials).toMatchObject({ accountId, apiToken: "token-1" });
    expect(credentials.workerSecret).toBe(probes[0]?.secret);

    // A new token for the same account keeps the Worker and its secret, so
    // the pinned Thread keeps reaching its container, and new Threads keep
    // starting on the ready Worker while the account prepares again.
    const rotating = await call("/cloudflare/connection", "PUT", {
      credentials: { accountId, apiToken: "token-2" },
    });
    expect(cloudflareOf(rotating.body.data).connection).toMatchObject({
      status: "preparing",
      updating: true,
    });
    expect(rotating.body.data.resolved).toEqual([
      expect.objectContaining({ providerId: "cloudflare", status: "ready" }),
    ]);
    const duringUpdate = "thr_00000000-0000-4000-8000-0000000005c2";
    await env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(duringUpdate, project, solo, timestamp, timestamp)
      .run();
    expect(
      await resolveThreadExecutionPin({
        db: env.DB,
        bindings,
        userId: solo,
        projectId: project,
        runnerProfileId: undefined,
        connectors,
      }),
    ).toMatchObject({
      credentialAccount: accountId,
      providerTemplate: probes[0]?.endpoint,
    });
    await prepare();
    expect(cloudflareOf((await call("")).body.data).connection).toMatchObject({
      status: "ready",
      updating: false,
    });
    expect(probes[1]).toEqual(probes[0]);
    // The image is already there; only the Worker is uploaded again.
    expect(world.metadata).toHaveLength(2);
    expect(world.metadata[1]?.migrations).toBeUndefined();
    const rotated = await Effect.runPromise(
      resolveExecutionTarget(bindings, threadId, { admission: false }),
    );
    if (rotated.credential.scope !== "personal") throw new Error("no account");
    expect(Redacted.value(rotated.credential.credentials)).toMatchObject({
      apiToken: "token-2",
      workerSecret: probes[0]?.secret,
    });
  });
});
