import { env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import type { GetProjectOrbScriptsResponse } from "@dx/api";
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
 * The one-time import of a repository's deprecated Orb files into its
 * Project's scripts, through GET /projects/:id/orb-scripts: a private GitHub
 * repository read through the real source admission (D1 grant, App JWT,
 * restricted installation token, revocation) against a fake GitHub API, a
 * public one read anonymously, and a Project dx cannot read.
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

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** GitHub's REST API for one private repository holding `files` at `sha`. */
const fakeGitHub = (files: Readonly<Record<string, string>>) => {
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
        const text = files[decodeURIComponent(path ?? "")];
        return text === undefined
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json({
              type: "file",
              path,
              encoding: "base64",
              size: new TextEncoder().encode(text).length,
              content: base64(text),
            });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }),
  );
  return requests;
};

const readScripts = async (projectId: string) => {
  const pending: Promise<unknown>[] = [];
  const response = await createProductApp().request(
    `/projects/${projectId}/orb-scripts`,
    { headers: { "x-request-id": "orb-import-read" } },
    bindings,
    {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  await Promise.all(pending);
  expect(response.status).toBe(200);
  const body = await response.json<GetProjectOrbScriptsResponse>();
  return {
    canManage: body.data.canManage,
    scripts: Object.fromEntries(
      body.data.scripts.map(({ kind, body: script }) => [kind, script]),
    ),
  };
};

const imported = async (projectId: string) =>
  (await env.DB.prepare("SELECT 1 FROM project_orb_import WHERE project_id = ?")
    .bind(projectId)
    .first()) !== null;

const auditRows = async (projectId: string) =>
  (
    await env.DB.prepare(
      `SELECT kind, action, body_sha256, actor_user_id, request_id
         FROM project_orb_script_audit WHERE project_id = ?
        ORDER BY occurred_at, rowid`,
    )
      .bind(projectId)
      .all()
  ).results;

const sha256 = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** A script saved before the import, as the migration or Settings left it. */
const seedScript = async (
  projectId: string,
  kind: string,
  body: string,
  auditedKind: string,
) => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_orb_script
         (project_id, kind, body, updated_by_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(projectId, kind, body, owner, now),
    env.DB.prepare(
      `INSERT INTO project_orb_script_audit
         (id, project_id, kind, action, body_sha256, actor_user_id,
          request_id, occurred_at)
       VALUES (?, ?, ?, 'set', ?, ?, 'seed', ?)`,
    ).bind(
      crypto.randomUUID(),
      projectId,
      auditedKind,
      await sha256(body),
      owner,
      now,
    ),
  ]);
};

describe("Importing a repository's Orb files into its Project's scripts", () => {
  /** Moves the Project's last failed read back past the backoff. */
  const backOffElapsed = async (projectId: string) => {
    await env.DB.prepare(
      "UPDATE project_orb_import_attempt SET attempted_at = ? WHERE project_id = ?",
    )
      .bind(new Date(Date.now() - 10 * 60_000).toISOString(), projectId)
      .run();
  };

  it("imports a private repository's files once through the restricted lease, and audits each", async () => {
    const projectId = await seedConnectedProject("Private-with-files", "g-1");
    const setup = "#!/bin/bash\nset -euo pipefail\nnpm ci\n";
    const desktopResume = '/opt/dx/desktop/chromium "http://localhost:3000"\n';
    const requests = fakeGitHub({
      ".agents/setup": setup,
      ".agents/desktop/resume": desktopResume,
      ".dx/services.yaml": "services: {}\n",
    });

    expect(await readScripts(projectId)).toEqual({
      canManage: true,
      scripts: { setup, "desktop-resume": desktopResume },
    });
    expect(await imported(projectId)).toBe(true);
    expect(await auditRows(projectId)).toEqual([
      {
        kind: "setup",
        action: "import",
        body_sha256: await sha256(setup),
        actor_user_id: owner,
        request_id: "orb-import-read",
      },
      {
        kind: "desktop-resume",
        action: "import",
        body_sha256: await sha256(desktopResume),
        actor_user_id: owner,
        request_id: "orb-import-read",
      },
    ]);
    // Only the three Orb files were read, each with the restricted lease,
    // which was then revoked.
    const reads = requests.filter((request) =>
      request.url.includes("/contents/"),
    );
    expect(reads.map(({ url }) => url.split("/contents/")[1])).toEqual([
      `.agents/setup?ref=${sha}`,
      `.agents/resume?ref=${sha}`,
      `.agents/desktop/resume?ref=${sha}`,
    ]);
    for (const read of reads) expect(read.auth).toBe("Bearer lease-token");
    expect(
      requests.some(
        (request) =>
          request.url === "https://api.github.com/installation/token" &&
          request.method === "DELETE",
      ),
    ).toBe(true);

    // The next read neither calls GitHub nor imports again.
    const before = requests.length;
    expect((await readScripts(projectId)).scripts).toEqual({
      setup,
      "desktop-resume": desktopResume,
    });
    expect(requests.length).toBe(before);
    expect(await auditRows(projectId)).toHaveLength(2);
  });

  it("keeps a moved script finding the repository through its old directory", async () => {
    const projectId = await seedConnectedProject("Private-self-path", "g-5");
    // The common way repository Orb files found the repository root.
    fakeGitHub({
      ".agents/resume":
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash, not a template.
        '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "${BASH_SOURCE[0]}")/.."\npnpm dev:check\n',
      ".agents/desktop/resume":
        '#!/bin/sh\n"$(dirname "$0")/../../scripts/open-app"\n',
    });

    expect((await readScripts(projectId)).scripts).toEqual({
      resume:
        '#!/usr/bin/env bash\ndx_script_dir="$PWD/.agents" # Where this script lived in the repository.\nset -euo pipefail\ncd "$dx_script_dir/.."\npnpm dev:check\n',
      "desktop-resume":
        '#!/bin/sh\ndx_script_dir="$PWD/.agents/desktop" # Where this script lived in the repository.\n"$dx_script_dir/../../scripts/open-app"\n',
    });
  });

  it("appends the repository's setup to a migrated pre-setup, and keeps a script saved since", async () => {
    const projectId = await seedConnectedProject("Private-pre-setup", "g-2");
    await seedScript(projectId, "setup", "echo pre\n", "pre-setup");
    await seedScript(projectId, "resume", "echo mine\n", "resume");
    fakeGitHub({
      ".agents/setup": "#!/usr/bin/env python3\nprint('hi')\n",
      ".agents/resume": "echo repository\n",
    });

    const combined = [
      "# The Project's pre-setup script.",
      "(",
      "echo pre",
      ") || exit",
      "",
      "# Imported from the repository's .agents/setup.",
      "/usr/bin/env python3 <<'DX_SCRIPT'",
      "print('hi')",
      "DX_SCRIPT",
      "",
    ].join("\n");
    expect((await readScripts(projectId)).scripts).toEqual({
      setup: combined,
      resume: "echo mine\n",
    });
    expect(
      (await auditRows(projectId)).map(
        ({ kind, action }) => `${kind} ${action}`,
      ),
    ).toEqual(["pre-setup set", "resume set", "setup import"]);
  });

  it("keeps a setup saved since the migration over the repository's", async () => {
    const projectId = await seedConnectedProject("Private-saved-setup", "g-3");
    await seedScript(projectId, "setup", "echo saved\n", "setup");
    fakeGitHub({ ".agents/setup": "echo repository\n" });

    expect((await readScripts(projectId)).scripts).toEqual({
      setup: "echo saved\n",
    });
    expect(await imported(projectId)).toBe(true);
  });

  it("imports nothing while GitHub rate-limits the read, backs off, then imports on a later read", async () => {
    const projectId = await seedConnectedProject("Private-limited", "g-4");
    const githubRequests = fakeGitHub({ ".agents/resume": "echo up\n" });
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

    expect(await readScripts(projectId)).toEqual({
      canManage: true,
      scripts: {},
    });
    expect(await imported(projectId)).toBe(false);
    expect(await auditRows(projectId)).toEqual([]);

    vi.stubGlobal("fetch", fake);
    const before = githubRequests.length;
    expect((await readScripts(projectId)).scripts).toEqual({});
    expect(githubRequests).toHaveLength(before);
    await backOffElapsed(projectId);
    expect((await readScripts(projectId)).scripts).toEqual({
      resume: "echo up\n",
    });
    expect(await imported(projectId)).toBe(true);
  });

  it("reads a public GitHub repository without a connection, retrying after its rate limit", async () => {
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
    let limited = true;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (limited) return new Response(null, { status: 429 });
        return url.endsWith("/HEAD/.agents/resume")
          ? new Response("pnpm install\n")
          : new Response(null, { status: 404 });
      }),
    );

    expect((await readScripts(projectId)).scripts).toEqual({});
    expect(await imported(projectId)).toBe(false);

    limited = false;
    const failedReads = requests.length;
    expect((await readScripts(projectId)).scripts).toEqual({});
    expect(requests).toHaveLength(failedReads);
    await backOffElapsed(projectId);
    expect((await readScripts(projectId)).scripts).toEqual({
      resume: "pnpm install\n",
    });
    expect(requests).toContain(
      "GET https://raw.githubusercontent.com/acme/public-app/HEAD/.agents/resume",
    );
    expect(await imported(projectId)).toBe(true);
  });

  it("marks a Project dx cannot read imported with nothing, without a request", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        requests.push(String(input));
        return new Response(null, { status: 500 });
      }),
    );
    const bare = (await createProjectViaApi("No-repository")).data.id;
    const other = (await createProjectViaApi("Other-host")).data.id;
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO project_repository (
        project_id, provider, binding_revision, full_name, web_url, clone_url,
        created_at, updated_at
      ) VALUES (?, 'git', 1, 'team/app', 'https://git.example/team/app',
        'https://git.example/team/app.git', ?, ?)
    `)
      .bind(other, now, now)
      .run();

    for (const projectId of [bare, other]) {
      expect(await readScripts(projectId)).toEqual({
        canManage: true,
        scripts: {},
      });
      expect(await imported(projectId)).toBe(true);
      expect(await auditRows(projectId)).toEqual([]);
    }
    expect(requests).toEqual([]);
  });
});
