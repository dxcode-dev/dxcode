import { env } from "cloudflare:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { projectRepositoryBrowseRoutes } from "../../src/projects/repository-browse.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/environment-variables/encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../src/settings/integrations/credential-vault.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_GITHUB_APP_CONFIGURATION,
} from "../../src/testing/bindings.js";
import {
  createProductApp,
  createProjectViaApi,
  otherPrincipal,
  owner,
  principal,
  bindings as productBindings,
} from "./product-route-fixture.js";

/**
 * The Project page's Commits and Files, read through the real source
 * admission (D1 grant, App JWT, restricted installation token, revocation)
 * against a fake GitHub, and anonymously for a public repository bound by URL.
 */
const bindings: Bindings = {
  ...productBindings,
  DX_ENV: "local",
  DX_AUTH_URL: "https://dx.test",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_INTEGRATION_GITHUB_APP: JSON.stringify({
    ...JSON.parse(TEST_GITHUB_APP_CONFIGURATION),
    privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  }),
};

const api = "https://api.github.com";
const repositoryId = "7301";
const installationId = "9301";
const sha = (digit: string) => digit.repeat(40);

afterEach(() => vi.unstubAllGlobals());

const seedConnectedProject = async (
  name: string,
  grantId: string,
  grantStatus = "active",
) => {
  const project = await createProjectViaApi(name);
  const projectId = project.data.id;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO github_installation (
        installation_id, app_id, provider_account_id, provider_account_type,
        provider_account_login, repository_selection, status,
        permissions_version, created_at, updated_at
      ) VALUES (?, '12345', '8301', 'user', 'acme', 'selected', 'active', 1, ?, ?)
    `).bind(installationId, now, now),
    env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, 'personal', ?, ?, ?, ?, ?, ?)
    `).bind(grantId, owner, installationId, grantStatus, owner, now, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO github_installation_repository (
        installation_id, provider_repository_id, full_name, web_url,
        visibility, entitled, last_reconciled_at
      ) VALUES (?, ?, 'acme/app', 'https://github.com/acme/app', 'private', 1, ?)
    `).bind(installationId, repositoryId, now),
    env.DB.prepare(`
      INSERT INTO project_repository (
        project_id, provider, binding_revision, full_name, web_url, clone_url,
        created_at, updated_at
      ) VALUES (?, 'github', 1, 'acme/app', 'https://github.com/acme/app',
        'https://github.com/acme/app.git', ?, ?)
    `).bind(projectId, now, now),
    env.DB.prepare(`
      INSERT INTO project_source_authority (
        project_id, provider, owner_scope, owner_id, owner_grant_id,
        installation_id, provider_repository_id, binding_revision, provenance,
        default_branch, source_health, authorization_epoch,
        installation_epoch, policy_revision, created_at, updated_at
      ) VALUES (?, 'github', 'personal', ?, ?, ?, ?, 1, 'live-grant',
        'trunk', 'available', 1, 1, 0, ?, ?)
    `).bind(projectId, owner, grantId, installationId, repositoryId, now, now),
  ]);
  return projectId;
};

const seedPublicProject = async (name: string, fullName: string) => {
  const project = await createProjectViaApi(name);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO project_repository (
      project_id, provider, binding_revision, full_name, web_url, clone_url,
      created_at, updated_at
    ) VALUES (?, 'github', 1, ?, ?, ?, ?, ?)
  `)
    .bind(
      project.data.id,
      fullName,
      `https://github.com/${fullName}`,
      `https://github.com/${fullName}.git`,
      now,
      now,
    )
    .run();
  return project.data.id;
};

/** The viewer connected GitHub: an unexpired user access token `ghu_viewer`. */
const connectViewerGitHub = async () => {
  const put = (purpose: "access-token" | "refresh-token", value: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const keyring = yield* loadConfigEncryptionKeyring(bindings);
        const vault = yield* IntegrationCredentialVault;
        return yield* vault.put(
          keyring,
          { scope: "personal", id: owner },
          purpose,
          value,
        );
      }).pipe(Effect.provide(IntegrationCredentialVaultD1(env.DB))),
    );
  const [access, refresh] = await Promise.all([
    put("access-token", "ghu_viewer"),
    put("refresh-token", "ghr_viewer"),
  ]);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO github_user_authorization (
      id, user_id, provider_account_id, provider_account_login, status,
      access_token_reference_id, refresh_token_reference_id, expires_at,
      refresh_expires_at, created_at, updated_at
    ) VALUES ('auth-viewer', ?, '42', 'octo', 'active', ?, ?, ?, NULL, ?, ?)
  `)
    .bind(
      owner,
      access.id,
      refresh.id,
      new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
      now,
      now,
    )
    .run();
};

const commit = (digit: string, message: string, date: string) => ({
  sha: sha(digit),
  commit: {
    message,
    author: { name: "Ada Lovelace", date },
    committer: { name: "GitHub", date },
  },
});

const contents: Record<string, unknown> = {
  "": [
    { name: "README.md", path: "README.md", type: "file" },
    { name: "src", path: "src", type: "dir" },
    { name: "package.json", path: "package.json", type: "file" },
    { name: "docs", path: "docs", type: "dir" },
  ],
  src: [{ name: "index.ts", path: "src/index.ts", type: "file" }],
  "README.md": { name: "README.md", path: "README.md", type: "file" },
};

/** Packet lines of a smart HTTP ref advertisement whose first ref is `head`. */
const refAdvertisement = (head: string | undefined) => {
  const line = (text: string) =>
    `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
  return `${line("# service=git-upload-pack\n")}0000${line(
    head === undefined
      ? `${"0".repeat(40)} capabilities^{}\0multi_ack\n`
      : `${head} HEAD\0multi_ack symref=HEAD:refs/heads/trunk\n`,
  )}0000`;
};

/**
 * A public Git host serving one repository over smart HTTP: `acme/app`'s
 * shape (docs/, src/, package.json, README.md) at two commits, as real
 * packfile objects. Its tip is `gitTip.head`.
 */
const gitTip = (() => {
  const encoder = new TextEncoder();
  const id = (type: string, data: Uint8Array) =>
    createHash("sha1")
      .update(`${type} ${data.length}\0`)
      .update(data)
      .digest("hex");
  const raw = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
  const tree = (entries: ReadonlyArray<[string, string, string]>) => {
    const parts: Uint8Array[] = [];
    for (const [mode, name, entryId] of entries)
      parts.push(encoder.encode(`${mode} ${name}\0`), raw(entryId));
    return Uint8Array.from(Buffer.concat(parts));
  };
  const blob = "e".repeat(40);
  const src = tree([["100644", "index.ts", blob]]);
  const docs = tree([["100644", "guide.md", blob]]);
  const root = tree([
    ["100644", "README.md", blob],
    ["40000", "docs", id("tree", docs)],
    ["100644", "package.json", blob],
    ["40000", "src", id("tree", src)],
  ]);
  const commitObject = (message: string, at: number, parent?: string) =>
    encoder.encode(
      `tree ${id("tree", root)}\n${parent === undefined ? "" : `parent ${parent}\n`}author Ada Lovelace <ada@example.test> ${at} +0000\ncommitter Ada Lovelace <ada@example.test> ${at} +0000\n\n${message}\n`,
    );
  const first = commitObject("Initial commit", 1761814800);
  const second = commitObject(
    "Add the CLI\n\nLonger body.",
    1761904800,
    id("commit", first),
  );
  const objects: Array<[number, Uint8Array]> = [
    [1, second],
    [1, first],
    [2, root],
    [2, src],
    [2, docs],
  ];
  const header = (type: number, size: number) => {
    const bytes = [(size >= 16 ? 0x80 : 0) | (type << 4) | (size & 15)];
    for (let rest = size >> 4; rest > 0; rest >>= 7)
      bytes.push((rest >= 128 ? 0x80 : 0) | (rest & 127));
    return Uint8Array.from(bytes);
  };
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, objects.length);
  const pack = Buffer.concat([
    Buffer.from("PACK"),
    Buffer.from([0, 0, 0, 2]),
    count,
    ...objects.flatMap(([type, data]) => [
      header(type, data.length),
      deflateSync(data),
    ]),
    Buffer.alloc(20),
  ]);
  const line = (payload: Uint8Array) =>
    Buffer.concat([
      Buffer.from((payload.length + 4).toString(16).padStart(4, "0")),
      payload,
    ]);
  const response = Buffer.concat([
    line(encoder.encode("packfile\n")),
    line(Buffer.concat([Buffer.from([1]), pack])),
    Buffer.from("0000"),
  ]);
  return { head: id("commit", second), response };
})();

/** Answers `fullName`'s smart HTTP requests as `gitTip`'s host. */
const gitHost =
  (fullName: string) =>
  (url: string): Response | undefined =>
    url ===
    `https://github.com/${fullName}.git/info/refs?service=git-upload-pack`
      ? new Response(refAdvertisement(gitTip.head))
      : url === `https://github.com/${fullName}.git/git-upload-pack`
        ? new Response(gitTip.response)
        : undefined;

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly auth?: string;
  readonly body?: string;
}

/**
 * GitHub for `acme/app` (connected, by ID) and `acme/<public>` (anonymous, by
 * name). `overrides` answers a URL first.
 */
const fakeGitHub = (
  overrides: (url: string, method: string) => Response | undefined = () =>
    undefined,
) => {
  const requests: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization") ?? undefined;
      requests.push({
        url,
        method,
        ...(auth === undefined ? {} : { auth }),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const override = overrides(url, method);
      if (override !== undefined) return override;
      if (url === `${api}/app/installations/${installationId}`)
        return Response.json({
          id: Number(installationId),
          account: { id: 8301, login: "acme", type: "User" },
          repository_selection: "selected",
          permissions: { contents: "write", metadata: "read" },
        });
      if (url === `${api}/app/installations/${installationId}/access_tokens`)
        return Response.json({
          token: "lease-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      if (url === `${api}/installation/token` && method === "DELETE")
        return new Response(null, { status: 204 });
      const base = url.startsWith(`${api}/repositories/${repositoryId}`)
        ? `${api}/repositories/${repositoryId}`
        : url.match(/^https:\/\/api\.github\.com\/repos\/acme\/[a-z-]+/)?.[0];
      if (base !== undefined) {
        const fullName =
          base === `${api}/repositories/${repositoryId}`
            ? "acme/app"
            : base.slice(`${api}/repos/`.length);
        const rest = url.slice(base.length);
        if (rest === "")
          return Response.json({
            id: Number(repositoryId),
            full_name: fullName,
            default_branch: "trunk",
          });
        if (rest === "/commits?per_page=5")
          return Response.json([
            commit("b", "Add the CLI\n\nLonger body.", "2026-10-31T10:00:00Z"),
            commit("a", "Initial commit", "2026-10-30T09:00:00Z"),
          ]);
        if (rest.startsWith("/contents")) {
          const path = decodeURIComponent(rest.slice("/contents/".length));
          const value = contents[rest === "/contents" ? "" : path];
          return value === undefined
            ? Response.json({ message: "Not Found" }, { status: 404 })
            : Response.json(value);
        }
      }
      if (url === `${api}/graphql` && method === "POST")
        return Response.json({
          data: {
            repository: {
              object: {
                e0: {
                  nodes: [
                    {
                      oid: sha("c"),
                      messageHeadline: "Write the docs",
                      committedDate: "2026-10-29T08:00:00Z",
                    },
                  ],
                },
                e1: {
                  nodes: [
                    {
                      oid: sha("b"),
                      messageHeadline: "Add the CLI",
                      committedDate: "2026-10-31T10:00:00Z",
                    },
                  ],
                },
              },
            },
          },
        });
      return Response.json({ message: "unexpected" }, { status: 500 });
    }),
  );
  return requests;
};

const browse = async (
  projectId: string,
  path?: string,
  requestPrincipal = principal,
) => {
  const app = createProductApp(requestPrincipal);
  app.route("/projects", projectRepositoryBrowseRoutes);
  const pending: Promise<unknown>[] = [];
  const response = await app.request(
    `/projects/${projectId}/repository${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`,
    {},
    bindings,
    {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  await Promise.all(pending);
  return { status: response.status, body: (await response.json()) as never };
};

describe("Project repository Commits and Files", () => {
  it("lists a connected repository's commits and root directory with each entry's last commit", async () => {
    const projectId = await seedConnectedProject("Browse-connected", "bg-1");
    const requests = fakeGitHub();

    const { status, body } = await browse(projectId);
    expect(status).toBe(200);
    expect(body).toEqual({
      status: "success",
      data: {
        state: "ready",
        repository: {
          provider: "github",
          fullName: "acme/app",
          webUrl: "https://github.com/acme/app",
        },
        defaultBranch: "trunk",
        commitsUrl: "https://github.com/acme/app/commits/trunk",
        commits: [
          {
            sha: sha("b"),
            subject: "Add the CLI",
            authorName: "Ada Lovelace",
            committedAt: "2026-10-31T10:00:00.000Z",
            url: `https://github.com/acme/app/commit/${sha("b")}`,
          },
          {
            sha: sha("a"),
            subject: "Initial commit",
            authorName: "Ada Lovelace",
            committedAt: "2026-10-30T09:00:00.000Z",
            url: `https://github.com/acme/app/commit/${sha("a")}`,
          },
        ],
        path: "",
        entries: [
          {
            name: "docs",
            path: "docs",
            kind: "directory",
            url: "https://github.com/acme/app/tree/trunk/docs",
            lastCommit: {
              sha: sha("c"),
              subject: "Write the docs",
              committedAt: "2026-10-29T08:00:00.000Z",
              url: `https://github.com/acme/app/commit/${sha("c")}`,
            },
          },
          {
            name: "src",
            path: "src",
            kind: "directory",
            url: "https://github.com/acme/app/tree/trunk/src",
            lastCommit: {
              sha: sha("b"),
              subject: "Add the CLI",
              committedAt: "2026-10-31T10:00:00.000Z",
              url: `https://github.com/acme/app/commit/${sha("b")}`,
            },
          },
          {
            name: "package.json",
            path: "package.json",
            kind: "file",
            url: "https://github.com/acme/app/blob/trunk/package.json",
          },
          {
            name: "README.md",
            path: "README.md",
            kind: "file",
            url: "https://github.com/acme/app/blob/trunk/README.md",
          },
        ],
        truncated: false,
      },
    });

    // Every repository read used the restricted lease, which was revoked.
    const reads = requests.filter(
      (request) =>
        request.url.startsWith(`${api}/repositories/`) ||
        request.url === `${api}/graphql`,
    );
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const read of reads) expect(read.auth).toBe("Bearer lease-token");
    expect(
      requests.some(
        (request) =>
          request.url === `${api}/installation/token` &&
          request.method === "DELETE",
      ),
    ).toBe(true);
    // The last-commit query asked about exactly the listed paths at the tip.
    const graphql = JSON.parse(
      requests.find((request) => request.url === `${api}/graphql`)?.body ??
        "{}",
    ) as { variables: Record<string, string> };
    expect(graphql.variables).toMatchObject({
      owner: "acme",
      name: "app",
      head: sha("b"),
      p0: "docs",
      p1: "src",
      p2: "package.json",
      p3: "README.md",
    });
  });

  it("opens a subdirectory, and answers path-not-found for a file or a missing path", async () => {
    const projectId = await seedConnectedProject("Browse-paths", "bg-2");
    fakeGitHub();

    const nested = await browse(projectId, "src");
    expect(nested.body).toMatchObject({
      data: {
        state: "ready",
        path: "src",
        entries: [
          {
            name: "index.ts",
            path: "src/index.ts",
            kind: "file",
            url: "https://github.com/acme/app/blob/trunk/src/index.ts",
          },
        ],
      },
    });
    for (const path of ["README.md", "missing"])
      expect((await browse(projectId, path)).body).toMatchObject({
        data: { state: "path-not-found", path, defaultBranch: "trunk" },
      });
  });

  it("keeps the listing when GitHub cannot answer last commits", async () => {
    const projectId = await seedConnectedProject("Browse-no-graphql", "bg-3");
    fakeGitHub((url) =>
      url === `${api}/graphql`
        ? new Response("unavailable", { status: 502 })
        : undefined,
    );

    const { body } = await browse(projectId);
    const data = (body as { data: { state: string; entries: object[] } }).data;
    expect(data.state).toBe("ready");
    expect(data.entries).toHaveLength(4);
    for (const entry of data.entries)
      expect(entry).not.toHaveProperty("lastCommit");
  });

  it("answers rate-limited, not an error, when GitHub rate-limits the read", async () => {
    const projectId = await seedConnectedProject("Browse-limited", "bg-4");
    fakeGitHub((url) =>
      url.includes("/commits?")
        ? Response.json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "9999999999",
              },
            },
          )
        : undefined,
    );

    expect(await browse(projectId)).toEqual({
      status: 200,
      body: {
        status: "success",
        data: {
          state: "unavailable",
          repository: {
            provider: "github",
            fullName: "acme/app",
            webUrl: "https://github.com/acme/app",
          },
          reason: "rate-limited",
        },
      },
    });
  });

  it("fails closed without a provider token after the connection is disconnected", async () => {
    const projectId = await seedConnectedProject(
      "Browse-disconnected",
      "bg-5",
      "disconnected",
    );
    const requests = fakeGitHub();

    expect((await browse(projectId)).body).toMatchObject({
      data: { state: "unavailable", reason: "reconnect" },
    });
    expect(
      requests.filter((request) => request.url.includes("access_tokens")),
    ).toEqual([]);
  });

  it("hides another user's Project and rejects a path that climbs out", async () => {
    const projectId = await seedConnectedProject("Browse-private", "bg-6");
    const requests = fakeGitHub();

    expect((await browse(projectId, undefined, otherPrincipal)).status).toBe(
      404,
    );
    expect((await browse(projectId, "../secrets")).status).toBe(400);
    expect((await browse(projectId, "/src")).status).toBe(400);
    expect(requests).toEqual([]);
  });

  it("answers none for a Project without a repository", async () => {
    const project = await createProjectViaApi("Browse-none");
    const requests = fakeGitHub();

    expect((await browse(project.data.id)).body).toEqual({
      status: "success",
      data: { state: "none" },
    });
    expect(requests).toEqual([]);
  });

  it("answers empty for a public repository without commits, from its ref advertisement alone", async () => {
    const projectId = await seedPublicProject("Browse-empty", "acme/empty");
    const requests = fakeGitHub((url) =>
      url ===
      "https://github.com/acme/empty.git/info/refs?service=git-upload-pack"
        ? new Response(refAdvertisement(undefined))
        : undefined,
    );

    expect((await browse(projectId)).body).toEqual({
      status: "success",
      data: {
        state: "empty",
        repository: {
          provider: "github",
          fullName: "acme/empty",
          webUrl: "https://github.com/acme/empty",
        },
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://github.com/acme/empty.git/info/refs?service=git-upload-pack",
    ]);
  });

  it("reads a public repository over Git's smart HTTP with no credential or API, and serves a repeat view at the same tip from cache", async () => {
    const projectId = await seedPublicProject(
      "Browse-public",
      "acme/public-app",
    );
    const requests = fakeGitHub(gitHost("acme/public-app"));

    const first = await browse(projectId);
    expect(first.body).toEqual({
      status: "success",
      data: {
        state: "ready",
        repository: {
          provider: "github",
          fullName: "acme/public-app",
          webUrl: "https://github.com/acme/public-app",
        },
        defaultBranch: "trunk",
        commitsUrl: "https://github.com/acme/public-app/commits/trunk",
        commits: [
          {
            sha: gitTip.head,
            subject: "Add the CLI",
            authorName: "Ada Lovelace",
            committedAt: "2025-10-31T10:00:00.000Z",
            url: `https://github.com/acme/public-app/commit/${gitTip.head}`,
          },
          expect.objectContaining({ subject: "Initial commit" }),
        ],
        path: "",
        entries: [
          {
            name: "docs",
            path: "docs",
            kind: "directory",
            url: "https://github.com/acme/public-app/tree/trunk/docs",
          },
          {
            name: "src",
            path: "src",
            kind: "directory",
            url: "https://github.com/acme/public-app/tree/trunk/src",
          },
          {
            name: "package.json",
            path: "package.json",
            kind: "file",
            url: "https://github.com/acme/public-app/blob/trunk/package.json",
          },
          {
            name: "README.md",
            path: "README.md",
            kind: "file",
            url: "https://github.com/acme/public-app/blob/trunk/README.md",
          },
        ],
        truncated: false,
      },
    });
    expect(requests.some((request) => request.url.startsWith(api))).toBe(false);
    for (const request of requests) expect(request.auth).toBeUndefined();
    expect(
      requests.filter((request) => request.url.endsWith("/git-upload-pack")),
    ).toHaveLength(2);
    expect((await browse(projectId, "src")).body).toMatchObject({
      data: { state: "ready", entries: [{ path: "src/index.ts" }] },
    });

    requests.length = 0;
    expect((await browse(projectId)).body).toEqual(first.body);
    // The tip itself is cached for 30 seconds, so a repeat view asks nothing.
    expect(requests).toEqual([]);
  });

  it("never serves a connected repository's answer to anyone else, or from cache", async () => {
    const projectId = await seedConnectedProject("Browse-scope", "bg-7");
    fakeGitHub();
    expect((await browse(projectId)).body).toMatchObject({
      data: { state: "ready", repository: { fullName: "acme/app" } },
    });

    // A non-member cannot reach the Project at all.
    const requests = fakeGitHub(() =>
      Response.json({ message: "down" }, { status: 503 }),
    );
    expect((await browse(projectId, undefined, otherPrincipal)).status).toBe(
      404,
    );
    expect(requests).toEqual([]);

    // The other user's own Project bound to the same URL reads anonymously;
    // the private repository refuses them, and nothing of the first read leaks.
    const app = createProductApp(otherPrincipal);
    const created = (await (
      await app.request(
        "/projects",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Browse-scope-other" }),
        },
        bindings,
      )
    ).json()) as { data: { id: string } };
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO project_repository (
        project_id, provider, binding_revision, full_name, web_url, clone_url,
        created_at, updated_at
      ) VALUES (?, 'github', 1, 'acme/app', 'https://github.com/acme/app',
        'https://github.com/acme/app.git', ?, ?)
    `)
      .bind(created.data.id, now, now)
      .run();
    fakeGitHub((url) =>
      url.startsWith("https://github.com/acme/app.git/info/refs")
        ? new Response("Authentication required", { status: 401 })
        : undefined,
    );
    expect(
      (await browse(created.data.id, undefined, otherPrincipal)).body,
    ).toMatchObject({
      data: { state: "unavailable", reason: "access-removed" },
    });

    // The owner's repeat read goes to GitHub again: no cached answer exists.
    fakeGitHub((url) =>
      url.includes("/commits?")
        ? Response.json({ message: "down" }, { status: 503 })
        : undefined,
    );
    expect((await browse(projectId)).body).toMatchObject({
      data: { state: "unavailable", reason: "provider-unavailable" },
    });
  });

  it("reads a public repository with the viewer's own GitHub token, and never caches that read", async () => {
    await connectViewerGitHub();
    const projectId = await seedPublicProject(
      "Browse-viewer",
      "acme/viewer-app",
    );
    let requests = fakeGitHub(gitHost("acme/viewer-app"));

    expect((await browse(projectId)).body).toMatchObject({
      data: {
        state: "ready",
        entries: [
          { name: "docs", lastCommit: { subject: "Write the docs" } },
          { name: "src", lastCommit: { subject: "Add the CLI" } },
          { name: "package.json" },
          { name: "README.md" },
        ],
      },
    });
    const apiReads = requests.filter((request) => request.url.startsWith(api));
    expect(apiReads.length).toBeGreaterThan(0);
    for (const read of apiReads) expect(read.auth).toBe("Bearer ghu_viewer");

    // Without the token the same tip is read anonymously, not from the cache.
    await env.DB.prepare(
      "UPDATE github_user_authorization SET status = 'revoked' WHERE id = 'auth-viewer'",
    ).run();
    requests = fakeGitHub(gitHost("acme/viewer-app"));
    expect((await browse(projectId)).body).toMatchObject({
      data: { state: "ready" },
    });
    expect(requests.some((request) => request.url.startsWith(api))).toBe(false);
    expect(
      requests.filter((request) => request.url.endsWith("/git-upload-pack")),
    ).toHaveLength(2);
    for (const request of requests) expect(request.auth).toBeUndefined();
  });

  it("answers provider-unavailable when the Git host errs, and caches nothing", async () => {
    const projectId = await seedPublicProject(
      "Browse-git-down",
      "acme/busy-app",
    );
    const host = gitHost("acme/busy-app");
    fakeGitHub(
      (url) =>
        (url.endsWith("/git-upload-pack")
          ? new Response("busy", { status: 503 })
          : undefined) ?? host(url),
    );
    expect((await browse(projectId)).body).toMatchObject({
      data: { state: "unavailable", reason: "provider-unavailable" },
    });

    fakeGitHub(host);
    expect((await browse(projectId)).body).toMatchObject({
      data: { state: "ready" },
    });
  });

  it("answers unavailable, not a crash, when a hostile Git host serves a zlib bomb", async () => {
    const projectId = await seedPublicProject("Browse-hostile", "acme/hostile");
    const bomb = deflateSync(new Uint8Array(16 * 1024 * 1024));
    const header = Buffer.alloc(12);
    header.write("PACK");
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(1, 8);
    // A blob that claims 100 bytes and inflates to 16 MiB.
    const pack = Buffer.concat([
      header,
      Buffer.from([0x80 | (3 << 4) | 4, 6]),
      bomb,
    ]);
    const line = (payload: Uint8Array) =>
      Buffer.concat([
        Buffer.from((payload.length + 4).toString(16).padStart(4, "0")),
        payload,
      ]);
    const hostile = Buffer.concat([
      line(Buffer.from("packfile\n")),
      line(Buffer.concat([Buffer.from([1]), pack])),
      Buffer.from("0000"),
    ]);
    const host = gitHost("acme/hostile");
    fakeGitHub((url) =>
      url.endsWith("/git-upload-pack") ? new Response(hostile) : host(url),
    );
    expect((await browse(projectId)).body).toMatchObject({
      data: { state: "unavailable", reason: "unsupported" },
    });
  });

  it("normalizes a trailing slash and rejects encoded traversal before any provider call", async () => {
    const projectId = await seedConnectedProject("Browse-encoded", "bg-8");
    const requests = fakeGitHub();
    for (const path of [
      "..",
      "src/../..",
      "%2e%2e/secrets",
      "src/%252e%252e",
      "src%2F..%2F..",
      "src\\..\\..",
      "/etc",
      "src//index",
      "./src",
    ])
      expect({ path, status: (await browse(projectId, path)).status }).toEqual({
        path,
        status: 400,
      });
    expect(requests).toEqual([]);

    expect((await browse(projectId, "src/")).body).toMatchObject({
      data: { state: "ready", path: "src" },
    });
  });
});
