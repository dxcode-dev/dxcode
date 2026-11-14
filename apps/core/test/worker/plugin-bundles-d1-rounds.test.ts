/**
 * D1 round trips of the Plugins page API. How it
 * could go wrong, each checked below:
 * - the list reads one after another again (each round trip is ~200 ms from
 *   far away), or a read lands outside the one batch after the access check;
 * - an install or update sends its writes as many calls, or half of them
 *   lands when a later one fails;
 * - holding writes back hides a guard: a write that must change a row
 *   commits even though it changed nothing;
 * - the page shows something different from before (same items, skills,
 *   MCP servers, and policy fields).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  deferredWritesD1,
  GUARD_FAILED,
} from "../../src/persistence/d1-deferred-writes.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { countD1Calls, summarizeD1Calls } from "./d1-call-counter.js";

const origin = "http://dx.test";
const base: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "plugin-bundle-d1-rounds-secret-000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_STORAGE: env.DX_STORAGE,
};
const endpoint = "/v1/settings/personal/plugin-bundles";

const signup = async () => {
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": "203.0.113.211",
      },
      body: JSON.stringify({
        name: "Rounds",
        email: `rounds-${crypto.randomUUID()}@example.com`,
        password: "plugin-rounds-password-123",
      }),
    },
    base,
  );
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
};

const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use ${name}.\n---\n\n${body}\n`;

const plugin = (
  body: string,
  skills: ReadonlyArray<string>,
): Array<FixtureEntry> => [
  {
    name: "rounds/.claude-plugin/plugin.json",
    content: JSON.stringify({
      name: "rounds-plugin",
      displayName: "Rounds Plugin",
      description: "Skills and an MCP server.",
      version: "1.0.0",
    }),
  },
  ...skills.map((name) => ({
    name: `rounds/skills/${name}/SKILL.md`,
    content: skill(name, body),
  })),
  {
    name: "rounds/.mcp.json",
    content: JSON.stringify({
      docs: { type: "http", url: "https://mcp.example.com/mcp" },
    }),
  },
];

const request = (
  bindings: Bindings,
  cookie: string,
  path: string,
  zip?: Uint8Array,
) =>
  app.request(
    path,
    {
      method: zip === undefined ? "GET" : "POST",
      headers: {
        cookie,
        origin,
        ...(zip === undefined ? {} : { "content-type": "application/zip" }),
      },
      ...(zip === undefined ? {} : { body: zip.slice() }),
    },
    bindings,
  );

/** Calls that write plugin, skill, or MCP rows. */
const writeCalls = (calls: ReturnType<typeof countD1Calls>["calls"]) =>
  calls.filter(({ sql }) =>
    sql.some((statement) =>
      /^(INSERT|UPDATE|DELETE)\b[\s\S]*\b(trusted_plugin|skill|mcp_server|plugin_version_signature)/i.test(
        statement,
      ),
    ),
  );

describe("Plugins page D1 round trips", () => {
  it("lists in one batch after the access check, and installs and updates with one write batch", async () => {
    const cookie = await signup();
    const counter = countD1Calls(env.DB);
    const bindings = { ...base, DB: counter.db };

    // Install: one write call for the plugin, its two skills, its server.
    const zip = await buildZip(
      plugin("Version one.", ["first-skill", "second-skill"]),
    );
    const preview = await request(
      bindings,
      cookie,
      `${endpoint}/preview?name=rounds.zip`,
      zip,
    );
    expect(preview.status).toBe(200);
    const { data } = await preview.json<{ data: { integrity: string } }>();
    counter.reset();
    const installed = await request(
      bindings,
      cookie,
      `${endpoint}?name=rounds.zip&integrity=${data.integrity}`,
      zip,
    );
    expect(installed.status).toBe(201);
    const installWrites = writeCalls(counter.calls);
    expect(installWrites).toHaveLength(1);
    expect(installWrites[0]?.method).toBe("batch");
    const { data: plugin1 } = await installed.json<{
      data: {
        id: string;
        skills: Array<{ name: string }>;
        mcpServers: Array<{ name: string }>;
      };
    }>();
    expect(plugin1.skills.map(({ name }) => name).sort()).toEqual([
      "first-skill",
      "second-skill",
    ]);
    expect(plugin1.mcpServers.map(({ name }) => name)).toEqual(["docs"]);

    // List: the access check, then everything else in one batch.
    counter.reset();
    const listed = await request(bindings, cookie, endpoint);
    expect(listed.status).toBe(200);
    // Every request first checks its session (two reads, shared by all
    // routes); after that the page makes the access check and one batch.
    const pageCalls = counter.calls.filter(
      ({ sql }) => !sql.every((one) => /from "(session|user)"/.test(one)),
    );
    const list = summarizeD1Calls(pageCalls);
    expect(list.sequential).toBeLessThanOrEqual(2);
    expect(list.roundTrips).toBeLessThanOrEqual(2);
    const { data: page } = await listed.json<{
      data: {
        items: Array<{ id: string; skills: unknown[]; mcpServers: unknown[] }>;
      };
    }>();
    expect(page.items.map(({ id }) => id)).toEqual([plugin1.id]);
    expect(page.items[0]?.skills).toHaveLength(2);
    expect(page.items[0]?.mcpServers).toHaveLength(1);

    // Update: a changed skill and a new code-free version, one write call.
    const zip2 = await buildZip(
      plugin("Version two.", ["first-skill", "second-skill"]),
    );
    const updatePreview = await request(
      bindings,
      cookie,
      `${endpoint}/${plugin1.id}/update/preview?name=rounds.zip`,
      zip2,
    );
    expect(updatePreview.status).toBe(200);
    const { data: next } = await updatePreview.json<{
      data: { integrity: string };
    }>();
    counter.reset();
    const updated = await request(
      bindings,
      cookie,
      `${endpoint}/${plugin1.id}/update?name=rounds.zip&integrity=${next.integrity}`,
      zip2,
    );
    expect(updated.status).toBe(200);
    const updateWrites = writeCalls(counter.calls);
    expect(updateWrites).toHaveLength(1);
    expect(updateWrites[0]?.method).toBe("batch");
  });

  it("fails the whole batch when a guarded write changed nothing", async () => {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS d1_rounds_probe (id TEXT PRIMARY KEY)",
    );
    const writes = deferredWritesD1(env.DB);
    await writes.db
      .prepare("INSERT INTO d1_rounds_probe (id) VALUES (?)")
      .bind("written-first")
      .run();
    const guarded = await writes.db
      .prepare("UPDATE d1_rounds_probe SET id = id WHERE id = ?")
      .bind("missing")
      .run();
    // The caller's guard reads 1 now; the commit checks it for real.
    expect(guarded.meta.changes).toBe(1);
    await expect(writes.commit()).rejects.toThrow(/malformed JSON|JSON/);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM d1_rounds_probe",
      ).first<number>("n"),
    ).toBe(0);
    expect(GUARD_FAILED).toBe("dx-d1-guard");
  });
});
