import { env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { TEST_GITHUB_APP_CONFIGURATION } from "../../src/testing/bindings.js";
import {
  createProductApp,
  createProjectViaApi,
  owner,
  bindings as productBindings,
} from "./product-route-fixture.js";

/**
 * The Orb page's repository files for a private GitHub repository, read
 * through the real source admission (D1 grant, App JWT, restricted
 * installation token, revocation) against a fake GitHub API.
 */
const bindings: Bindings = {
  ...productBindings,
  DX_ENV: "local",
  DX_AUTH_URL: "https://dx.test",
  DX_INTEGRATION_GITHUB_APP: JSON.stringify({
    ...JSON.parse(TEST_GITHUB_APP_CONFIGURATION),
    privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  }),
};

const sha = "c".repeat(40);
const repositoryId = "7201";
const installationId = "9201";

afterEach(() => vi.unstubAllGlobals());

/** A private repository bound to the project through the owner's grant. */
const seedConnectedProject = async (name: string, grantId: string) => {
  const project = await createProjectViaApi(name);
  const projectId = project.data.id;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO github_installation (
        installation_id, app_id, provider_account_id, provider_account_type,
        provider_account_login, repository_selection, status,
        permissions_version, created_at, updated_at
      ) VALUES (?, '12345', '8201', 'user', 'acme', 'selected', 'active', 1, ?, ?)
    `).bind(installationId, now, now),
    env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, 'personal', ?, ?, 'active', ?, ?, ?)
    `).bind(grantId, owner, installationId, owner, now, now),
    env.DB.prepare(`
      INSERT OR IGNORE INTO github_installation_repository (
        installation_id, provider_repository_id, full_name, web_url,
        visibility, entitled, last_reconciled_at
      ) VALUES (?, ?, 'acme/private-app', 'https://github.com/acme/private-app',
        'private', 1, ?)
    `).bind(installationId, repositoryId, now),
    env.DB.prepare(`
      INSERT INTO project_repository (
        project_id, provider, binding_revision, full_name, web_url, clone_url,
        created_at, updated_at
      ) VALUES (?, 'github', 1, 'acme/private-app',
        'https://github.com/acme/private-app',
        'https://github.com/acme/private-app.git', ?, ?)
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

/** GitHub's REST API for one private repository holding `files` at `sha`. */
const fakeGitHub = (files: ReadonlyArray<string>) => {
  const requests: Array<{ url: string; method: string; auth?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization") ?? undefined;
      requests.push({ url, method, ...(auth === undefined ? {} : { auth }) });
      const api = "https://api.github.com";
      if (url === `${api}/app/installations/${installationId}`)
        return Response.json({
          id: Number(installationId),
          account: { id: 8201, login: "acme", type: "User" },
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
      if (url === `${api}/repositories/${repositoryId}`)
        return Response.json({
          id: Number(repositoryId),
          full_name: "acme/private-app",
          html_url: "https://github.com/acme/private-app",
          clone_url: "https://github.com/acme/private-app.git",
          private: true,
          visibility: "private",
          archived: false,
          default_branch: "trunk",
        });
      if (url === `${api}/repositories/${repositoryId}/commits/trunk`)
        return Response.json({ sha });
      const contents = `${api}/repositories/${repositoryId}/contents/`;
      if (url.startsWith(contents)) {
        const [path, query] = url.slice(contents.length).split("?");
        expect(query).toBe(`ref=${sha}`);
        return files.includes(decodeURIComponent(path ?? ""))
          ? Response.json({ type: "file", path })
          : Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }),
  );
  return requests;
};

const readFiles = async (projectId: string) => {
  const pending: Promise<unknown>[] = [];
  const response = await createProductApp().request(
    `/projects/${projectId}/orb-files`,
    {},
    bindings,
    {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  await Promise.all(pending);
  expect(response.status).toBe(200);
  return response.json();
};

describe("Project Orb files for a connected GitHub repository", () => {
  it("lists the files a private repository has on its default branch, linked on GitHub", async () => {
    const projectId = await seedConnectedProject("Private-with-files", "g-1");
    const requests = fakeGitHub([".agents/setup", ".agents/desktop/resume"]);

    expect(await readFiles(projectId)).toEqual({
      status: "success",
      data: {
        state: "checked",
        repository: { fullName: "acme/private-app", defaultBranch: "trunk" },
        files: [
          {
            path: ".agents/setup",
            present: true,
            url: "https://github.com/acme/private-app/blob/trunk/.agents/setup",
          },
          { path: ".agents/resume", present: false },
          {
            path: ".agents/desktop/resume",
            present: true,
            url: "https://github.com/acme/private-app/blob/trunk/.agents/desktop/resume",
          },
          { path: ".dx/services.yaml", present: false },
        ],
      },
    });
    // Every read used the restricted lease, which was then revoked.
    const reads = requests.filter((request) =>
      request.url.includes("/contents/"),
    );
    expect(reads).toHaveLength(4);
    for (const read of reads) expect(read.auth).toBe("Bearer lease-token");
    expect(
      requests.some(
        (request) =>
          request.url === "https://api.github.com/installation/token" &&
          request.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("reports every file missing when the repository has none", async () => {
    const projectId = await seedConnectedProject("Private-without", "g-2");
    fakeGitHub([]);

    const body = (await readFiles(projectId)) as {
      data: { state: string; files: Array<{ present: boolean }> };
    };
    expect(body.data.state).toBe("checked");
    expect(body.data.files.map((file) => file.present)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("answers unreadable, not an error, when GitHub rate-limits the read", async () => {
    const projectId = await seedConnectedProject("Private-limited", "g-3");
    fakeGitHub([]);
    const fake = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) =>
        String(input).includes("/contents/")
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
          : fake(input, init),
      ),
    );

    expect(await readFiles(projectId)).toEqual({
      status: "success",
      data: { state: "unreadable" },
    });
  });

  it("reads a public GitHub repository without a connection, and survives its rate limit", async () => {
    const project = await createProjectViaApi("Public-repository");
    const projectId = project.data.id;
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO project_repository (
        project_id, provider, binding_revision, full_name, web_url, clone_url,
        created_at, updated_at
      ) VALUES (?, 'github', 1, 'acme/public-app',
        'https://github.com/acme/public-app',
        'https://github.com/acme/public-app.git', ?, ?)
    `)
      .bind(projectId, now, now)
      .run();
    let limited = false;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (limited) return new Response(null, { status: 429 });
        return url.endsWith("/HEAD/.dx/services.yaml")
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 404 });
      }),
    );

    expect(await readFiles(projectId)).toMatchObject({
      data: {
        state: "checked",
        repository: { fullName: "acme/public-app" },
        files: [
          { path: ".agents/setup", present: false },
          { path: ".agents/resume", present: false },
          { path: ".agents/desktop/resume", present: false },
          {
            path: ".dx/services.yaml",
            present: true,
            url: "https://github.com/acme/public-app/blob/HEAD/.dx/services.yaml",
          },
        ],
      },
    });
    expect(requests).toContain(
      "HEAD https://raw.githubusercontent.com/acme/public-app/HEAD/.agents/setup",
    );

    limited = true;
    expect(await readFiles(projectId)).toEqual({
      status: "success",
      data: { state: "unreadable" },
    });
  });
});
