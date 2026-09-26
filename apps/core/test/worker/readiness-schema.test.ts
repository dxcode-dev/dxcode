import { env } from "cloudflare:test";
import { Effect } from "effect";
import { expect, it } from "vitest";
import migrationManifest from "../../migration-manifest.json" with {
  type: "json",
};
import { loadReadinessRequirements } from "../../src/readiness/requirements.js";
import { createTestBindings } from "../../src/testing/bindings.js";

it.each(["filename", "reverse"])(
  "accepts migrations applied in %s order through the real Worker D1 binding",
  async (order) => {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS __alchemy_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)",
    ).run();
    await env.DB.prepare("DELETE FROM __alchemy_migrations").run();
    const migrations = [...migrationManifest.d1];
    if (order === "reverse") migrations.reverse();
    await env.DB.batch(
      migrations.map(({ filename, sha256 }, index) =>
        env.DB.prepare(
          "INSERT INTO __alchemy_migrations (id, hash, name) VALUES (?, ?, ?)",
        ).bind(index + 1, sha256, filename),
      ),
    );
    await expect(
      Effect.runPromise(
        loadReadinessRequirements(
          createTestBindings({
            FLUE_DX_AGENT_AGENT: env.THREAD_EXECUTION,
            PLUGIN_TRIGGER_DELIVERY: env.PLUGIN_TRIGGER_DELIVERY,
            THREAD_EXECUTION: env.THREAD_EXECUTION,
            SUBSCRIPTION_CREDENTIAL_COORDINATOR:
              env.SUBSCRIPTION_CREDENTIAL_COORDINATOR,
            DB: env.DB,
            DX_STORAGE: env.DX_STORAGE,
          }),
        ),
      ),
    ).resolves.toEqual({
      dxEnv: "test",
      runtimeMode: "deployed",
      revision: "a".repeat(40),
      e2bTemplateBuildId: "test-template-build",
      migrationManifestVersion: "1",
      dxdPublicUrl: "https://dx.test/",
      dxdReleaseUrl: "https://releases.test/dxd",
      dxdReleaseSha256: "a".repeat(64),
    });
  },
);
