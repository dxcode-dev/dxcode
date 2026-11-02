import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
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
// Wrangler starts a local runtime for each of the 120-odd migrations, which
// took about 45 s per run. Apply them once per set of migrations, Wrangler
// version, and fixture database, then start every run from a copy of that
// state.
const migratedStateKey = createHash("sha256");
const migrationsPath = path.resolve("migrations");
for (const name of (await readdir(migrationsPath)).sort())
  migratedStateKey
    .update(name)
    .update("\0")
    .update(await readFile(path.join(migrationsPath, name)))
    .update("\0");
migratedStateKey
  .update(
    JSON.stringify(
      JSON.parse(await readFile(fixtureConfig, "utf8")).d1_databases,
    ),
  )
  .update(
    JSON.parse(
      await readFile(
        path.resolve("node_modules/wrangler/package.json"),
        "utf8",
      ),
    ).version,
  );
const migratedStateCache = path.resolve(
  "../../node_modules/.cache/dx-lifecycle-d1",
  migratedStateKey.digest("hex"),
);
try {
  await cp(migratedStateCache, persistencePath, { recursive: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
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
  const staged = `${migratedStateCache}.${process.pid}`;
  await mkdir(path.dirname(migratedStateCache), { recursive: true });
  await cp(persistencePath, staged, { recursive: true });
  await rename(staged, migratedStateCache).catch(() =>
    rm(staged, { recursive: true, force: true }),
  );
}

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
  // Its own process group: `pnpm` may be a launcher that exits on SIGTERM
  // without passing it on, which would leave wrangler and workerd listening.
  { stdio: "inherit", detached: true },
);
// A fixture that dies mid-run fails the next request with "fetch failed";
// say how it died, so the failure points at its cause.
let stopping = false;
let tests;
worker.once("exit", (code, signal) => {
  if (stopping) return;
  // Without its fixture a test waits forever on its next request, so end the
  // run now and say how the fixture died.
  console.error(
    `[lifecycle] The fixture's wrangler dev exited during the run (code ${code}, signal ${signal}).`,
  );
  tests?.kill("SIGTERM");
});
const stopWorker = (signal) => {
  stopping = true;
  try {
    process.kill(-worker.pid, signal);
  } catch {}
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopWorker(signal);
    process.exit(1);
  });

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

  // Asynchronous, so the fixture's exit above is seen while the tests run.
  tests = spawn(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.lifecycle.config.ts"],
    {
      stdio: "inherit",
      env: { ...process.env, DX_LIFECYCLE_FIXTURE_URL: fixtureUrl },
    },
  );
  const status = await new Promise((resolve) =>
    tests.once("exit", (code) => resolve(code)),
  );
  if (status !== 0 || worker.exitCode !== null || worker.signalCode !== null)
    process.exitCode = status || 1;
} finally {
  if (worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    stopWorker("SIGTERM");
    await exited;
  }
  // The launcher can exit before the group; wait until nothing in it is left.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(-worker.pid, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  stopWorker("SIGKILL");
  await rm(persistencePath, { recursive: true, force: true });
}
