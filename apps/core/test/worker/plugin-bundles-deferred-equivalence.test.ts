/**
 * Held-back writes (install and update send one atomic batch) must leave
 * D1 exactly as writing straight through does. How it could go wrong, each
 * checked below:
 * - a step reads what an earlier step wrote and, under deferral, sees the
 *   old state (the binding now throws on such a read);
 * - a write lands twice, out of order, or not at all when batched;
 * - a signature, a removed and an added skill, a changed skill, or a moved
 *   MCP server differs afterwards;
 * - a guarded write whose row vanished between the reads and the commit
 *   leaves part of the update behind.
 */
import { env } from "cloudflare:test";
import {
  type PluginId,
  PluginIntegrityConflict,
  type PluginTarget,
  type UserId,
} from "@dx/domain";
import { Effect, Exit } from "effect";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { pluginBundleLayers } from "../../src/settings/plugins/bundles/layers.js";
import {
  type PluginBundleInput,
  PluginBundleService,
} from "../../src/settings/plugins/bundles/service.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { network } from "./network-boundary.js";

// The signed fixture from plugin-signing.test.ts: ssh-keygen over these
// exact files.
const signedFiles: Record<string, string> = {
  "plugin.json":
    '{"$schema":"https://agent-plugins.org/schemas/1.1.0/plugin.schema.json","name":"com.acme.signed","displayName":"Signed","version":"1.0.0","description":"A signed plugin.","extensions":{"dev.dxcode":{"apiVersion":1,"entry":"dev.dxcode/index.js","permissions":{"events":["agent.end"]}}}}\n',
  "dev.dxcode/index.js": "export default () => {};\n",
  "skills/notes/SKILL.md":
    "---\nname: notes\ndescription: Use to take notes.\n---\n\nTake notes.\n",
};
const signature =
  "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg3lLU3HiyAPpBJTfZhXbFWGOjfR\nDoEw95uGnuEs0HyZEAAAAJZHgtcGx1Z2luAAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1l\nZDI1NTE5AAAAQMbgszd8J9iMkcInNhdys7DowbEidqVYhGAioheeI8hCnPx9V5KTrTSTLb\n/maCIQh/GeaT8CdMX5cIWPDX3ILQ8=\n-----END SSH SIGNATURE-----\n";

const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Use ${name}.\n---\n\n${body}\n`;

/** A plugin with code, skills, and one remote MCP server. */
const kit = (
  skills: Record<string, string>,
  mcpUrl: string,
): Array<FixtureEntry> => [
  {
    name: "kit/plugin.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name: "com.acme.kit",
      displayName: "Kit",
      description: "Code, skills, and a server.",
      version: "1.0.0",
      extensions: {
        "dev.dxcode": {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions: { events: ["agent.end"] },
        },
      },
    }),
  },
  { name: "kit/dev.dxcode/index.js", content: "export default () => {};\n" },
  ...Object.entries(skills).map(([name, body]) => ({
    name: `kit/skills/${name}/SKILL.md`,
    content: skill(name, body),
  })),
  {
    name: "kit/mcp.json",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
      mcpServers: { docs: { type: "streamable-http", url: mcpUrl } },
    }),
  },
];

const signedPlugin = (signed: boolean): Array<FixtureEntry> =>
  signed
    ? [
        ...Object.entries(signedFiles).map(([name, content]) => ({
          name,
          content,
        })),
        { name: "plugin.sig", content: signature },
      ]
    : Object.entries({
        ...signedFiles,
        "skills/notes/SKILL.md": skill("notes", "Take short notes."),
      }).map(([name, content]) => ({ name, content }));

let people = 0;
const person = async (): Promise<UserId> => {
  people += 1;
  const id = `usr_deferred_equivalence_${people}_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES (?, 'Equivalence', ?, 1, ?, ?)`,
  )
    .bind(id, `${id}@example.com`, Date.now(), Date.now())
    .run();
  return id as UserId;
};

const zipInput = async (
  entries: ReadonlyArray<FixtureEntry>,
): Promise<PluginBundleInput> => ({
  type: "zip",
  label: "fixture.zip",
  bytes: await buildZip(entries),
});

const run = <A>(
  db: D1Database,
  deferWrites: boolean,
  effect: Effect.Effect<A, unknown, PluginBundleService>,
) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(pluginBundleLayers(db, env.DX_STORAGE, { deferWrites })),
    ),
  );

const audit = (userId: UserId) => ({ userId, requestId: "req_equivalence" });

const install = (
  db: D1Database,
  deferWrites: boolean,
  target: PluginTarget,
  entries: ReadonlyArray<FixtureEntry>,
) =>
  Effect.gen(function* () {
    const input = yield* Effect.promise(() => zipInput(entries));
    const service = yield* PluginBundleService;
    const preview = yield* service.preview(target, input);
    return yield* service.install(
      target,
      input,
      preview.bundle.integrity,
      audit(target.id as UserId),
    );
  }).pipe((effect) => run(db, deferWrites, effect));

const update = (
  db: D1Database,
  deferWrites: boolean,
  target: PluginTarget,
  id: PluginId,
  entries: ReadonlyArray<FixtureEntry>,
) =>
  Effect.gen(function* () {
    const input = yield* Effect.promise(() => zipInput(entries));
    const service = yield* PluginBundleService;
    const preview = yield* service.previewUpdate(target, id, input);
    return yield* service.update(
      target,
      id,
      input,
      preview.bundle.integrity,
      audit(target.id as UserId),
      true,
    );
  }).pipe((effect) => run(db, deferWrites, effect));

/**
 * Everything a target's plugins, skills, and servers wrote, without IDs,
 * owners, or times, sorted: equal for equal content.
 */
const dump = async (userId: string) => {
  const queries: Record<string, string> = {
    plugins: "SELECT * FROM trusted_plugin WHERE target_id = ?1",
    versions: `SELECT * FROM trusted_plugin_version WHERE plugin_id IN
               (SELECT id FROM trusted_plugin WHERE target_id = ?1)`,
    files: `SELECT * FROM trusted_plugin_file WHERE plugin_id IN
            (SELECT id FROM trusted_plugin WHERE target_id = ?1)`,
    signatures: `SELECT * FROM plugin_version_signature WHERE plugin_id IN
                 (SELECT id FROM trusted_plugin WHERE target_id = ?1)`,
    skills: "SELECT * FROM skill WHERE target_id = ?1",
    skillVersions: `SELECT * FROM skill_version WHERE skill_id IN
                    (SELECT id FROM skill WHERE target_id = ?1)`,
    servers: "SELECT * FROM mcp_server WHERE target_id = ?1",
  };
  const kept = (column: string) =>
    column === "removed_at" || !/(^id$|_id$|_at$|_ids_json$)/.test(column);
  const out: Record<string, string[]> = {};
  for (const [name, sql] of Object.entries(queries)) {
    const rows = (await env.DB.prepare(sql).bind(userId).all()).results;
    out[name] = rows
      .map((row) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(row)
              .filter(([column]) => kept(column))
              .map(([column, value]) => [
                column,
                // A removed row keeps a timestamp; only "removed" matters.
                column === "removed_at" ? value !== null : value,
              ])
              .sort(([a], [b]) => String(a).localeCompare(String(b))),
          ),
        ),
      )
      .sort();
  }
  return out;
};

/** No publisher lists the key: the signature verifies as key-only. */
const noPublisher = () =>
  network.use(
    http.get("https://cloudflare-dns.com/dns-query", () =>
      HttpResponse.json({}),
    ),
  );

const flow = async (deferWrites: boolean) => {
  noPublisher();
  const userId = await person();
  const target = { scope: "personal", id: userId } as PluginTarget;
  const kit1 = await install(
    env.DB,
    deferWrites,
    target,
    kit(
      { alpha: "Version one.", beta: "Version one." },
      "https://mcp.one.example/mcp",
    ),
  );
  if (!Exit.isSuccess(kit1))
    throw new Error(`install: ${Exit.isFailure(kit1) && String(kit1.cause)}`);
  // Update: beta removed, gamma added, alpha changed, the server moved.
  const kit2 = await update(
    env.DB,
    deferWrites,
    target,
    kit1.value.id,
    kit(
      { alpha: "Version two.", gamma: "New." },
      "https://mcp.two.example/mcp",
    ),
  );
  if (!Exit.isSuccess(kit2))
    throw new Error(`update: ${Exit.isFailure(kit2) && String(kit2.cause)}`);
  // Update that only changes: alpha again, the server's path on one host.
  const kit3 = await update(
    env.DB,
    deferWrites,
    target,
    kit1.value.id,
    kit(
      { alpha: "Version three.", gamma: "New." },
      "https://mcp.two.example/v2",
    ),
  );
  if (!Exit.isSuccess(kit3))
    throw new Error(`update 2: ${Exit.isFailure(kit3) && String(kit3.cause)}`);
  // Signatures: an unsigned install, then an update to the signed version.
  const unsigned = await install(
    env.DB,
    deferWrites,
    target,
    signedPlugin(false),
  );
  if (!Exit.isSuccess(unsigned))
    throw new Error(
      `unsigned: ${Exit.isFailure(unsigned) && String(unsigned.cause)}`,
    );
  const signed = await update(
    env.DB,
    deferWrites,
    target,
    unsigned.value.id,
    signedPlugin(true),
  );
  if (!Exit.isSuccess(signed))
    throw new Error(
      `signed: ${Exit.isFailure(signed) && String(signed.cause)}`,
    );
  return dump(userId);
};

describe("held-back plugin writes", () => {
  it("leave D1 as writing straight through does: install, update with adds and removes, signatures", async () => {
    const immediate = await flow(false);
    const deferred = await flow(true);
    expect(deferred).toEqual(immediate);
    // The flow really did what it says.
    expect(deferred.signatures).toHaveLength(1);
    expect(
      deferred.skills.filter((row) => row.includes('"removed_at":true')),
    ).toHaveLength(1);
    expect(deferred.skillVersions.length).toBeGreaterThanOrEqual(5);
    expect(deferred.servers.join()).toContain("https://mcp.two.example/v2");
  });

  it("rolls the whole update back when a guarded row is gone at commit", async () => {
    const userId = await person();
    const target = { scope: "personal", id: userId } as PluginTarget;
    const installed = await install(
      env.DB,
      true,
      target,
      kit(
        { alpha: "Version one.", beta: "Version one." },
        "https://mcp.one.example/mcp",
      ),
    );
    if (!Exit.isSuccess(installed)) throw new Error("install failed");
    const before = await dump(userId);
    // Between the update's reads and its commit, the plugin is removed:
    // the first write batch to reach D1 is the commit; remove it just then.
    let removed = false;
    const racing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!removed && statements.length > 3) {
              removed = true;
              await env.DB.prepare(
                "UPDATE trusted_plugin SET removed_at = ? WHERE id = ?",
              )
                .bind(new Date().toISOString(), installed.value.id)
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await update(
      racing as D1Database,
      true,
      target,
      installed.value.id,
      kit(
        { alpha: "Version two.", beta: "Version two." },
        "https://mcp.one.example/mcp",
      ),
    );
    expect(removed).toBe(true);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(String(result.cause)).toContain(PluginIntegrityConflict.name);
    const after = await dump(userId);
    // Nothing of the update landed: only the removal made outside it.
    expect({ ...after, plugins: [] }).toEqual({ ...before, plugins: [] });
    expect(after.plugins.join()).toContain('"removed_at":true');
  });
});
