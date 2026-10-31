import { env } from "cloudflare:test";
import {
  McpServerRepository,
  type ProjectId,
  SkillRepository,
  type UserId,
} from "@dx/domain";
import { Effect, Layer } from "effect";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { McpServerRepositoryD1 } from "../../src/settings/mcp-servers/repository-d1.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { SkillRepositoryD1 } from "../../src/settings/skills/repository-d1.js";
import { network } from "./network-boundary.js";

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "plugin-bundle-route-secret-0000000000",
};
const endpoint = "/v1/settings/personal/plugin-bundles";
const commit = "d4dfed4e1c578cfea8bd6e64873e4f5e5b7e36f0";

const signup = async (email: string) => {
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": "203.0.113.46",
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
});
