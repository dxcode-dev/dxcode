import { env } from "cloudflare:test";
import {
  McpServerRepository,
  type ProjectId,
  SkillRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Layer } from "effect";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { McpServerRepositoryD1 } from "../../src/settings/mcp-servers/repository-d1.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { SkillRepositoryD1 } from "../../src/settings/skills/repository-d1.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { network } from "./network-boundary.js";

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "plugin-bundle-route-secret-0000000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};
const endpoint = "/v1/settings/personal/plugin-bundles";
const commit = "d4dfed4e1c578cfea8bd6e64873e4f5e5b7e36f0";

let signups = 40;
const signup = async (email: string) => {
  signups += 1;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        // Sign-ups are rate limited per address.
        "cf-connecting-ip": `203.0.113.${signups}`,
      },
      body: JSON.stringify({
        name: "Bundle Owner",
        email,
        password: "plugin-bundle-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const { user } = await response.json<{ user: { id: string } }>();
  return { cookie, userId: user.id as UserId };
};

const call = (
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown; zip?: Uint8Array } = {},
) =>
  app.request(
    path,
    {
      method: init.method ?? ((init.json ?? init.zip) ? "POST" : "GET"),
      headers: {
        cookie,
        origin,
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.zip === undefined
          ? {}
          : { "content-type": "application/zip" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      ...(init.zip === undefined ? {} : { body: init.zip.slice() }),
    },
    bindings,
  );

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: Use ${name}.\n---\n\nDo the ${name} thing.\n`;

const plugin = (prefix: string): ReadonlyArray<FixtureEntry> => [
  {
    name: `${prefix}.claude-plugin/plugin.json`,
    content: JSON.stringify({
      name: "example-plugin",
      displayName: "Example Plugin",
      description: "A skill, a command, and MCP servers.",
      version: "1.0.0",
    }),
  },
  {
    name: `${prefix}skills/bundle-skill/SKILL.md`,
    content: skill("bundle-skill"),
  },
  {
    name: `${prefix}commands/greet.md`,
    content: "---\ndescription: Greet\n---\nSay hello to $ARGUMENTS.",
  },
  {
    name: `${prefix}.mcp.json`,
    content: JSON.stringify({
      docs: { type: "http", url: "https://mcp.example.com/mcp" },
      local: { command: "npx", args: ["server"] },
    }),
  },
  { name: `${prefix}hooks/hooks.json`, content: "{}" },
];

const resolution = (userId: UserId) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const skills = yield* SkillRepository;
      const mcp = yield* McpServerRepository;
      const candidates = yield* skills.listThreadCandidates(userId);
      const connections = yield* mcp.listForExecution(
        userId,
        "prj_00000000-0000-4000-8000-000000000001" as ProjectId,
      );
      return {
        skills: candidates.map(({ skill: value }) => value.name),
        mcp: connections.map(({ server }) => server.name),
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SkillRepositoryD1(env.DB),
          McpServerRepositoryD1(env.DB),
        ),
      ),
    ),
  );

interface PreviewBody {
  readonly data: {
    readonly integrity: string;
    readonly conflicts: ReadonlyArray<string>;
    readonly source: unknown;
    readonly manifest: {
      readonly name: string;
      readonly skills: ReadonlyArray<{ readonly name: string }>;
      readonly mcpServers: ReadonlyArray<{ readonly name: string }>;
      readonly skipped: ReadonlyArray<{ readonly path: string }>;
    };
  };
}

describe("plugin bundle routes with D1", () => {
  it("imports a ZIP bundle as one plugin, gates its items on the plugin, and removes them", async () => {
    const { cookie, userId } = await signup("bundle-zip@example.com");
    const archive = await buildZip(plugin("example-plugin/"));

    const preview = await call(`${endpoint}/preview?name=example.zip`, cookie, {
      zip: archive,
    });
    expect(preview.status).toBe(200);
    const reviewed = await preview.json<PreviewBody>();
    expect(reviewed.data.conflicts).toEqual([]);
    expect(reviewed.data.source).toEqual({ type: "zip", label: "example.zip" });
    expect(reviewed.data.manifest.skills.map(({ name }) => name)).toEqual([
      "bundle-skill",
    ]);
    expect(reviewed.data.manifest.mcpServers.map(({ name }) => name)).toEqual([
      "docs",
    ]);
    expect(reviewed.data.manifest.skipped.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        ".mcp.json#local",
        "hooks/hooks.json",
        "commands/",
      ]),
    );
    // Previewing installed nothing.
    expect(await resolution(userId)).toEqual({ skills: [], mcp: [] });

    const stale = await call(
      `${endpoint}?name=example.zip&integrity=${"0".repeat(64)}`,
      cookie,
      { zip: archive },
    );
    expect(stale.status).toBe(409);

    const installed = await call(
      `${endpoint}?name=example.zip&integrity=${reviewed.data.integrity}`,
      cookie,
      { zip: archive },
    );
    expect(installed.status).toBe(201);
    const bundle = await installed.json<{
      data: {
        id: string;
        enabled: boolean;
        skills: ReadonlyArray<{ name: string }>;
        mcpServers: ReadonlyArray<{ name: string; reviewed: boolean }>;
      };
    }>();
    expect(bundle.data).toMatchObject({
      enabled: true,
      skills: [{ name: "bundle-skill" }],
      mcpServers: [{ name: "docs", reviewed: false }],
    });

    const listed = await call(endpoint, cookie);
    expect(
      (await listed.json<{ data: { items: ReadonlyArray<unknown> } }>()).data
        .items,
    ).toHaveLength(1);
    const skills = await call("/v1/settings/personal/skills", cookie);
    expect(await skills.text()).toContain("bundle-skill");
    const servers = await call("/v1/settings/personal/mcp-servers", cookie);
    expect(await servers.text()).toContain("https://mcp.example.com/mcp");

    // The skill loads in new Threads; the server waits for tool review.
    expect(await resolution(userId)).toEqual({
      skills: ["bundle-skill"],
      mcp: ["docs"],
    });

    const again = await call(`${endpoint}/preview?name=example.zip`, cookie, {
      zip: archive,
    });
    expect((await again.json<PreviewBody>()).data.conflicts).toEqual(
      expect.arrayContaining([
        "A plugin named example-plugin is already installed here.",
        "A skill named bundle-skill already exists in Skills.",
      ]),
    );

    const disabled = await call(`${endpoint}/${bundle.data.id}`, cookie, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(await resolution(userId)).toEqual({ skills: [], mcp: [] });
    const offSkills = await call("/v1/settings/personal/skills", cookie);
    expect(await offSkills.text()).toContain('"plugin-disabled"');

    await call(`${endpoint}/${bundle.data.id}`, cookie, {
      method: "PATCH",
      json: { enabled: true },
    });
    expect((await resolution(userId)).skills).toEqual(["bundle-skill"]);

    const removed = await call(`${endpoint}/${bundle.data.id}`, cookie, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await resolution(userId)).toEqual({ skills: [], mcp: [] });
    const afterSkills = await call("/v1/settings/personal/skills", cookie);
    expect(await afterSkills.text()).not.toContain("bundle-skill");
    const afterServers = await call(
      "/v1/settings/personal/mcp-servers",
      cookie,
    );
    expect(await afterServers.text()).not.toContain("mcp.example.com");

    // Removing frees the names for a new import.
    const reimport = await call(
      `${endpoint}?name=example.zip&integrity=${reviewed.data.integrity}`,
      cookie,
      { zip: archive },
    );
    expect(reimport.status).toBe(201);
  });

  it("refuses hostile archives", async () => {
    const { cookie } = await signup("bundle-hostile@example.com");
    const traversal = await call(`${endpoint}/preview`, cookie, {
      zip: await buildZip([
        ...plugin(""),
        { name: "../../escape.md", content: "x" },
      ]),
    });
    expect(traversal.status).toBe(400);
    expect(await traversal.text()).toContain("unsafe path");

    const oversize = await app.request(
      `${endpoint}/preview`,
      {
        method: "POST",
        headers: {
          cookie,
          origin,
          "content-type": "application/zip",
          "content-length": String(17 * 1024 * 1024),
        },
        body: new Uint8Array(16),
      },
      bindings,
    );
    expect(oversize.status).toBe(400);
    expect(await oversize.text()).toContain("larger than");

    const garbage = await call(`${endpoint}/preview`, cookie, {
      zip: new TextEncoder().encode("not a zip"),
    });
    expect(garbage.status).toBe(400);
  });

  it("imports a plugin folder from a public GitHub repository at the reviewed commit", async () => {
    const { cookie, userId } = await signup("bundle-github@example.com");
    const archive = await buildZip(
      [
        { name: "plugins-main/README.md", content: "# Plugins" },
        ...plugin("plugins-main/plugins/example/"),
      ],
      commit,
    );
    const requested: Array<string> = [];
    network.use(
      http.get(
        "https://codeload.github.com/acme/plugins/zip/:ref",
        ({ params }) => {
          requested.push(String(params.ref));
          return params.ref === "main" || params.ref === commit
            ? new HttpResponse(archive.slice(), {
                headers: { "content-type": "application/zip" },
              })
            : new HttpResponse(null, { status: 404 });
        },
      ),
    );

    const preview = await call(`${endpoint}/preview`, cookie, {
      json: {
        url: "https://github.com/acme/plugins/tree/main/plugins/example",
      },
    });
    expect(preview.status).toBe(200);
    const reviewed = await preview.json<PreviewBody>();
    expect(reviewed.data.source).toEqual({
      type: "github",
      repository: "acme/plugins",
      ref: "main",
      path: "plugins/example",
      commit,
    });

    const installed = await call(endpoint, cookie, {
      json: {
        source: reviewed.data.source,
        reviewedIntegrity: reviewed.data.integrity,
      },
    });
    expect(installed.status).toBe(201);
    expect(requested).toEqual(["main", commit]);
    expect((await resolution(userId)).skills).toEqual(["bundle-skill"]);

    const notGitHub = await call(`${endpoint}/preview`, cookie, {
      json: { url: "https://gitlab.com/acme/plugins" },
    });
    expect(notGitHub.status).toBe(400);
  });

  it("updates a GitHub plugin to its ref's latest commit, replacing changed items and keeping unchanged ones", async () => {
    const { cookie, userId } = await signup("bundle-update@example.com");
    const first = "1111111111111111111111111111111111111111";
    const second = "2222222222222222222222222222222222222222";
    const version = (
      skills: ReadonlyArray<readonly [string, string]>,
      servers: Record<string, unknown>,
      sha: string,
    ) =>
      buildZip(
        [
          {
            name: "kit-main/.claude-plugin/plugin.json",
            content: JSON.stringify({ name: "update-kit", version: "1.0.0" }),
          },
          ...skills.map(([name, body]) => ({
            name: `kit-main/skills/${name}/SKILL.md`,
            content: `---\nname: ${name}\ndescription: Use ${name}.\n---\n\n${body}\n`,
          })),
          { name: "kit-main/.mcp.json", content: JSON.stringify(servers) },
        ],
        sha,
      );
    const archives = new Map<string, Uint8Array>([
      [
        first,
        await version(
          [
            ["kept-skill", "Version one."],
            ["old-skill", "Going away."],
          ],
          {
            docs: { type: "http", url: "https://mcp.example.com/mcp" },
            gone: { type: "http", url: "https://gone.example.com/mcp" },
          },
          first,
        ),
      ],
      [
        second,
        await version(
          [
            ["kept-skill", "Version two."],
            ["new-skill", "Arrived."],
          ],
          {
            docs: { type: "http", url: "https://mcp.example.com/mcp" },
            extra: { type: "http", url: "https://extra.example.com/mcp" },
          },
          second,
        ),
      ],
    ]);
    let head = first;
    network.use(
      http.get(
        "https://codeload.github.com/acme/kit/zip/:ref",
        ({ params }) => {
          const ref = String(params.ref);
          const archive = archives.get(ref === "HEAD" ? head : ref);
          return archive === undefined
            ? new HttpResponse(null, { status: 404 })
            : new HttpResponse(archive.slice(), {
                headers: { "content-type": "application/zip" },
              });
        },
      ),
    );

    const preview = await call(`${endpoint}/preview`, cookie, {
      json: { url: "https://github.com/acme/kit" },
    });
    const reviewed = await preview.json<PreviewBody>();
    const installed = await call(endpoint, cookie, {
      json: {
        source: reviewed.data.source,
        reviewedIntegrity: reviewed.data.integrity,
      },
    });
    expect(installed.status).toBe(201);
    const bundle = await installed.json<{
      data: {
        id: string;
        skills: ReadonlyArray<{ id: string; name: string }>;
        mcpServers: ReadonlyArray<{ id: string; name: string }>;
      };
    }>();
    const updates = `${endpoint}/${bundle.data.id}/update`;

    // Nothing new on the ref yet.
    const unchanged = await call(`${updates}/preview`, cookie, { json: {} });
    expect(unchanged.status).toBe(200);
    expect(
      (await unchanged.json<{ data: { upToDate: boolean } }>()).data.upToDate,
    ).toBe(true);

    head = second;
    const update = await call(`${updates}/preview`, cookie, { json: {} });
    expect(update.status).toBe(200);
    const changes = await update.json<{
      data: {
        upToDate: boolean;
        integrity: string;
        conflicts: ReadonlyArray<string>;
        source: { commit: string };
        skills: ReadonlyArray<{ name: string; change: string }>;
        mcpServers: ReadonlyArray<{ name: string; change: string }>;
      };
    }>();
    expect(changes.data.upToDate).toBe(false);
    expect(changes.data.conflicts).toEqual([]);
    expect(changes.data.source.commit).toBe(second);
    expect(changes.data.skills).toEqual([
      { name: "kept-skill", change: "changed" },
      { name: "new-skill", change: "added" },
      { name: "old-skill", change: "removed" },
    ]);
    expect(
      changes.data.mcpServers.map(({ name, change }) => ({ name, change })),
    ).toEqual([
      { name: "docs", change: "unchanged" },
      { name: "extra", change: "added" },
      { name: "gone", change: "removed" },
    ]);

    const stale = await call(updates, cookie, {
      json: {
        source: changes.data.source,
        reviewedIntegrity: "0".repeat(64),
      },
    });
    expect(stale.status).toBe(409);

    const applied = await call(updates, cookie, {
      json: {
        source: changes.data.source,
        reviewedIntegrity: changes.data.integrity,
      },
    });
    expect(applied.status).toBe(200);
    const after = await applied.json<{
      data: {
        source: { commit: string };
        skills: ReadonlyArray<{ id: string; name: string }>;
        mcpServers: ReadonlyArray<{ id: string; name: string }>;
      };
    }>();
    expect(after.data.source.commit).toBe(second);
    const id = (
      items: ReadonlyArray<{ id: string; name: string }>,
      name: string,
    ) => items.find((item) => item.name === name)?.id;
    // A changed skill keeps its identity and gets a new active version.
    expect(id(after.data.skills, "kept-skill")).toBe(
      id(bundle.data.skills, "kept-skill"),
    );
    expect(after.data.skills.map(({ name }) => name).sort()).toEqual([
      "kept-skill",
      "new-skill",
    ]);
    // An unchanged server keeps its identity, and with it its approvals.
    expect(id(after.data.mcpServers, "docs")).toBe(
      id(bundle.data.mcpServers, "docs"),
    );
    expect(after.data.mcpServers.map(({ name }) => name).sort()).toEqual([
      "docs",
      "extra",
    ]);
    const skills = await call("/v1/settings/personal/skills", cookie);
    const kept = (
      await skills.json<{
        data: {
          items: ReadonlyArray<{
            name: string;
            activeVersion: number;
            active: { instructions: string };
          }>;
        };
      }>()
    ).data.items.find(({ name }) => name === "kept-skill");
    expect(kept?.activeVersion).toBe(2);
    expect(kept?.active.instructions).toBe("Version two.");
    expect((await resolution(userId)).skills.sort()).toEqual([
      "kept-skill",
      "new-skill",
    ]);
    expect((await resolution(userId)).mcp.sort()).toEqual(["docs", "extra"]);

    const again = await call(`${updates}/preview`, cookie, { json: {} });
    expect(
      (await again.json<{ data: { upToDate: boolean } }>()).data.upToDate,
    ).toBe(true);
    const repeat = await call(updates, cookie, {
      json: {
        source: changes.data.source,
        reviewedIntegrity: changes.data.integrity,
      },
    });
    expect(repeat.status).toBe(400);
    expect(await repeat.text()).toContain("already up to date");
  });

  it("updates a ZIP plugin from a new upload", async () => {
    const { cookie } = await signup("bundle-zip-update@example.com");
    const first = await buildZip(plugin("example-plugin/"));
    const preview = await call(`${endpoint}/preview?name=example.zip`, cookie, {
      zip: first,
    });
    const reviewed = await preview.json<PreviewBody>();
    const installed = await call(
      `${endpoint}?name=example.zip&integrity=${reviewed.data.integrity}`,
      cookie,
      { zip: first },
    );
    const { data } = await installed.json<{ data: { id: string } }>();
    const updates = `${endpoint}/${data.id}/update`;

    // Without a new upload there is nothing to read.
    const missing = await call(`${updates}/preview`, cookie, { json: {} });
    expect(missing.status).toBe(400);

    const second = await buildZip([
      ...plugin("example-plugin/").filter(
        ({ name }) => !name.endsWith(".mcp.json"),
      ),
      {
        name: "example-plugin/skills/bundle-skill/reference/notes.md",
        content: "New notes.",
      },
    ]);
    const update = await call(`${updates}/preview?name=example-2.zip`, cookie, {
      zip: second,
    });
    const changes = await update.json<{
      data: {
        integrity: string;
        skills: ReadonlyArray<{ name: string; change: string }>;
        mcpServers: ReadonlyArray<{ name: string; change: string }>;
      };
    }>();
    expect(changes.data.skills).toEqual([
      { name: "bundle-skill", change: "changed" },
    ]);
    expect(changes.data.mcpServers).toEqual([
      {
        name: "docs",
        endpoint: "https://mcp.example.com/mcp",
        change: "removed",
        credentialsCleared: false,
      },
    ]);
    const applied = await call(
      `${updates}?name=example-2.zip&integrity=${changes.data.integrity}`,
      cookie,
      { zip: second },
    );
    expect(applied.status).toBe(200);
    const after = await applied.json<{
      data: { source: unknown; mcpServers: ReadonlyArray<unknown> };
    }>();
    expect(after.data.source).toEqual({ type: "zip", label: "example-2.zip" });
    expect(after.data.mcpServers).toEqual([]);
  });

  it("clears a server's secrets when an update moves it to another origin, and keeps them for a new path on the same origin", async () => {
    const { cookie } = await signup("bundle-origin@example.com");
    const first = "3333333333333333333333333333333333333333";
    const second = "4444444444444444444444444444444444444444";
    const secret = "header-secret-that-must-not-move";
    const version = (servers: Record<string, unknown>, sha: string) =>
      buildZip(
        [
          {
            name: "moves-main/.claude-plugin/plugin.json",
            content: JSON.stringify({ name: "origin-kit" }),
          },
          { name: "moves-main/.mcp.json", content: JSON.stringify(servers) },
        ],
        sha,
      );
    const archives = new Map<string, Uint8Array>([
      [
        first,
        await version(
          {
            moving: { type: "http", url: "https://mcp.move.test/mcp" },
            staying: { type: "http", url: "https://mcp.stay.test/mcp" },
          },
          first,
        ),
      ],
      [
        second,
        await version(
          {
            moving: { type: "http", url: "https://mcp.elsewhere.test/mcp" },
            staying: { type: "http", url: "https://mcp.stay.test/v2/mcp" },
          },
          second,
        ),
      ],
    ]);
    let head = first;
    // Everything an MCP server receives, by host.
    const received: Array<{ host: string; headers: Record<string, string> }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "codeload.github.com") {
          const ref = url.pathname.split("/").at(-1) ?? "";
          const archive = archives.get(ref === "main" ? head : ref);
          return archive === undefined
            ? new Response(null, { status: 404 })
            : new Response(archive.slice(), {
                headers: { "content-type": "application/zip" },
              });
        }
        if (url.hostname === "1.1.1.1") {
          return Response.json({
            Status: 0,
            Answer:
              url.searchParams.get("type") === "A"
                ? [{ type: 1, data: "93.184.216.34" }]
                : [],
          });
        }
        if (url.hostname.endsWith(".test") && request.method === "POST") {
          received.push({
            host: url.hostname,
            headers: Object.fromEntries(request.headers),
          });
          const message = (await request.json()) as {
            readonly id?: number;
            readonly method: string;
          };
          if (message.id === undefined)
            return new Response(null, { status: 202 });
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fake", version: "1" },
                  }
                : message.method === "tools/list"
                  ? {
                      tools: [
                        {
                          name: "lookup",
                          description: "Look something up.",
                          inputSchema: { type: "object", properties: {} },
                        },
                      ],
                    }
                  : {},
          });
        }
        if (request.method === "GET")
          return new Response(null, { status: 405 });
        return new Response("unexpected", { status: 599 });
      }),
    );

    const preview = await call(`${endpoint}/preview`, cookie, {
      json: { url: "https://github.com/acme/moves/tree/main" },
    });
    expect(preview.status).toBe(200);
    const reviewed = await preview.json<PreviewBody>();
    const installed = await call(endpoint, cookie, {
      json: {
        source: reviewed.data.source,
        reviewedIntegrity: reviewed.data.integrity,
      },
    });
    expect(installed.status).toBe(201);
    const bundle = await installed.json<{
      data: {
        id: string;
        mcpServers: ReadonlyArray<{ id: string; name: string }>;
      };
    }>();
    const serverId = (name: string) =>
      bundle.data.mcpServers.find((server) => server.name === name)?.id ?? "";

    // The person adds an API key to each server in MCP settings.
    for (const name of ["moving", "staying"]) {
      const patched = await call(
        `/v1/settings/personal/mcp-servers/${serverId(name)}`,
        cookie,
        {
          method: "PATCH",
          json: {
            headers: [{ name: "X-Api-Key", value: secret, secret: true }],
          },
        },
      );
      expect(patched.status).toBe(200);
    }
    const secrets = async (name: string) =>
      (
        await env.DB.prepare(
          "SELECT name FROM mcp_server_secret WHERE server_id = ?",
        )
          .bind(serverId(name))
          .all()
      ).results.length;
    expect(await secrets("moving")).toBe(1);
    expect(await secrets("staying")).toBe(1);

    head = second;
    const updates = `${endpoint}/${bundle.data.id}/update`;
    const update = await call(`${updates}/preview`, cookie, { json: {} });
    const changes = await update.json<{
      data: {
        integrity: string;
        source: unknown;
        mcpServers: ReadonlyArray<{
          name: string;
          change: string;
          credentialsCleared: boolean;
        }>;
      };
    }>();
    expect(
      changes.data.mcpServers.map(({ name, change, credentialsCleared }) => ({
        name,
        change,
        credentialsCleared,
      })),
    ).toEqual([
      { name: "moving", change: "changed", credentialsCleared: true },
      { name: "staying", change: "changed", credentialsCleared: false },
    ]);
    const applied = await call(updates, cookie, {
      json: {
        source: changes.data.source,
        reviewedIntegrity: changes.data.integrity,
      },
    });
    expect(applied.status).toBe(200);
    expect(await secrets("moving")).toBe(0);
    expect(await secrets("staying")).toBe(1);

    // Connecting each server again: the key reaches the same host only.
    received.length = 0;
    for (const name of ["moving", "staying"]) {
      const discovered = await call(
        `/v1/settings/personal/mcp-servers/${serverId(name)}/discover`,
        cookie,
        { method: "POST", json: {} },
      );
      expect(discovered.status).toBe(200);
    }
    const sent = (host: string) =>
      received.filter((request) => request.host === host);
    expect(sent("mcp.elsewhere.test").length).toBeGreaterThan(0);
    expect(
      sent("mcp.elsewhere.test").some(
        ({ headers }) => headers["x-api-key"] !== undefined,
      ),
    ).toBe(false);
    expect(sent("mcp.stay.test").length).toBeGreaterThan(0);
    expect(
      sent("mcp.stay.test").every(
        ({ headers }) => headers["x-api-key"] === secret,
      ),
    ).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
