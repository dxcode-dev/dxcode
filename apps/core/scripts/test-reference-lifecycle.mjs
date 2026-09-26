import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const fixtureConfig =
  "test/lifecycle-fixture/dist/dx_flue_lifecycle_fixture/wrangler.json";

const run = (args) => {
  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate a lifecycle fixture port."));
      return;
    }
    server.close(() => resolve(address.port));
  });
});
const persistencePath = await mkdtemp(
  path.join(tmpdir(), "dx-flue-lifecycle-"),
);

run([
  "exec",
  "tsc",
  "-p",
  "test/lifecycle-fixture/tsconfig.json",
  "--pretty",
  "false",
]);
run([
  "exec",
  "vite",
  "build",
  "--config",
  "test/lifecycle-fixture/vite.config.ts",
]);
run([
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "dx-lifecycle-fixture",
  "--local",
  "--persist-to",
  persistencePath,
  "--config",
  fixtureConfig,
]);

const fixtureToken = "dxu_fixture-token-0000000000000000000";
const fixtureUserId = "00000000-0000-4000-8000-000000000001";
const keyHash = createHash("sha256").update(fixtureToken).digest("base64url");
run([
  "exec",
  "wrangler",
  "d1",
  "execute",
  "dx-lifecycle-fixture",
  "--local",
  "--persist-to",
  persistencePath,
  "--config",
  fixtureConfig,
  "--command",
  `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${fixtureUserId}', 'Fixture', 'fixture@dx.local', 1, 0, 0); INSERT INTO apikey (id, configId, name, start, referenceId, prefix, key, enabled, rateLimitEnabled, requestCount, remaining, createdAt, updatedAt, permissions) VALUES ('fixture-api-key', 'user-keys', 'Fixture', 'dxu_fixture', '${fixtureUserId}', 'dxu_', '${keyHash}', 1, 0, 0, NULL, 0, 0, '{"dx":["projects:read","projects:write","threads:read","threads:write","agents:access","settings:read","settings:write"]}');`,
]);

const worker = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    persistencePath,
    "--config",
    fixtureConfig,
  ],
  { stdio: "inherit" },
);

try {
  const fixtureUrl = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 15_000;
  while (true) {
    if (worker.exitCode !== null) process.exit(worker.exitCode ?? 1);
    try {
      const response = await fetch(
        new URL("/__fixture/reference-headers", fixtureUrl),
      );
      if (response.ok) break;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error("Lifecycle fixture did not become ready.");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.lifecycle.config.ts"],
    {
      stdio: "inherit",
      env: { ...process.env, DX_LIFECYCLE_FIXTURE_URL: fixtureUrl },
    },
  );
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  if (worker.exitCode === null) {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
  }
  await rm(persistencePath, { recursive: true, force: true });
}
