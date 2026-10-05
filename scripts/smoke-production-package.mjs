import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { relative, resolve } from "node:path";
import {
  loadMigrationManifest,
  sourceControlSchemaVersion,
} from "./migration-manifest.mjs";
import {
  deriveDurableObjectBindings,
  validateProductionPackage,
} from "./production-package.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");

const availablePort = async () => {
  const server = createServer();
  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not allocate a package smoke port.");
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return address.port;
};

const waitForWorker = async (origin, child) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error("Packaged Worker exited before smoke verification.");
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    "Packaged Worker did not become ready for smoke verification.",
  );
};

export const stopSmokeChild = (child, timeoutMs = 5_000) =>
  new Promise((resolveStopped) => {
    if (child.exitCode !== null) return resolveStopped();
    let killTimer;
    const cleanup = () => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      child.off("exit", cleanup);
      resolveStopped();
    };
    const termTimer = setTimeout(() => {
      child.kill("SIGKILL");
      killTimer = setTimeout(cleanup, timeoutMs);
    }, timeoutMs);
    child.once("exit", cleanup);
    child.kill("SIGTERM");
  });

export const smokeProductionPackage = async (packageRoot) => {
  const manifest = await validateProductionPackage(packageRoot);
  const migrations = await loadMigrationManifest();
  const smokeRoot = resolve(
    workspaceRoot,
    ".dx/package-smoke",
    manifest.artifact.sha256,
  );
  rmSync(smokeRoot, { recursive: true, force: true });
  mkdirSync(smokeRoot, { recursive: true });
  const smokeHome = resolve(smokeRoot, "home");
  mkdirSync(smokeHome);
  const workerMain = relative(
    smokeRoot,
    resolve(packageRoot, "worker/index.js"),
  );
  const assets = relative(smokeRoot, resolve(packageRoot, "assets"));
  const workloadIdentityKeyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const workloadIdentityKid = "smoke-key-0001";
  const scalarValues = {
    BETTER_AUTH_SECRET: "package-smoke-not-a-secret-package-smoke",
    DX_AUTH_EMAIL_FROM: "sign-in@package-smoke.invalid",
    DX_AUTH_TRUSTED_ORIGINS: "http://127.0.0.1",
    DX_AUTH_URL: "http://127.0.0.1",
    DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({
      activeVersion: 1,
      keys: { 1: Buffer.alloc(32).toString("base64") },
    }),
    DX_DEPLOYMENT_REVISION: manifest.identity.revision,
    DX_DEPLOYMENT_TARGET: "package-smoke",
    DX_DXD_PUBLIC_URL: "http://127.0.0.1/",
    DX_DXD_RELEASE_SHA256: manifest.dxd.sha256,
    DX_DXD_RELEASE_URL: "https://releases.test/dxd",
    DX_E2B_TEMPLATE: "package-smoke",
    DX_E2B_TEMPLATE_BUILD_ID: "package-smoke-build",
    DX_E2B_TIMEOUT_MS: "1000",
    DX_ENV: "package-smoke",
    DX_INTEGRATION_BITBUCKET_OAUTH: "",
    DX_INTEGRATION_GITHUB_APP: "{}",
    DX_MANAGED_SSH_SIGNING_ENABLED: "true",
    DX_GITHUB_COPILOT_CLIENT_ID: "",
    DX_INSTALLED_PLUGINS: "",
    DX_MODEL_DEPLOYMENT_PROVIDERS: "",
    DX_MODEL_ENDPOINT_ALLOWLIST: "",
    DX_MODEL_WORKERS_AI_ENABLED: "",
    DX_MIGRATION_MANIFEST_VERSION: String(manifest.migrations.manifestVersion),
    DX_RUNNER_PROFILE_CATALOG: JSON.stringify({
      version: 1,
      defaultProfileId: "e2b-default",
      profiles: [],
    }),
    DX_RUNTIME_MODE: "deployed",
    DX_SIGNUP_ENABLED: "",
    DX_SOURCE_CONTROL_SCHEMA_VERSION: sourceControlSchemaVersion(migrations),
    DX_SOURCE_SHALLOW_CLONE: "false",
    DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES: JSON.stringify({
      version: 1,
      policies: [],
    }),
    DX_WORKLOAD_IDENTITY_ISSUER:
      "https://package-smoke.invalid/api/workload-identity",
    DX_WORKLOAD_IDENTITY_SIGNING_KEYS: JSON.stringify({
      version: 1,
      activeKid: workloadIdentityKid,
      keys: [
        {
          kid: workloadIdentityKid,
          privateKeyPkcs8: workloadIdentityKeyPair.privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
          publicJwk: {
            ...workloadIdentityKeyPair.publicKey.export({ format: "jwk" }),
            use: "sig",
            alg: "RS256",
            kid: workloadIdentityKid,
          },
        },
      ],
    }),
    DX_WORKSPACE_INACTIVITY_MS: "300000",
    E2B_API_KEY: "package-smoke-not-a-provider-key",
    SARVAM_API_KEY: "",
    EXA_API_KEY: "",
    DX_TURNSTILE_SITE_KEY: "package-smoke-not-a-site-key",
    DX_TURNSTILE_SECRET_KEY: "package-smoke-not-a-secret",
  };
  const scalarBindings = manifest.bindings.filter(({ type }) =>
    ["text", "secret"].includes(type),
  );
  if (
    JSON.stringify(Object.keys(scalarValues).sort()) !==
    JSON.stringify(scalarBindings.map(({ name }) => name).sort())
  )
    throw new Error(
      "Package smoke scalar bindings drifted from the manifest contract.",
    );
  const exactlyOne = (type) => {
    const matches = manifest.bindings.filter(
      (binding) => binding.type === type,
    );
    if (matches.length !== 1)
      throw new Error(`Package smoke requires exactly one ${type} binding.`);
    return matches[0];
  };
  const d1 = exactlyOne("d1");
  const r2 = exactlyOne("r2");
  const ai = exactlyOne("workers-ai");
  const email = exactlyOne("send-email");
  const durableObjects = deriveDurableObjectBindings({
    authoredConfig: JSON.parse(
      readFileSync(resolve(workspaceRoot, "apps/core/wrangler.jsonc"), "utf8"),
    ),
    bindingContract: { bindings: manifest.bindings },
    migrationManifest: migrations,
  });
  const accountedBindings = new Set([
    ...Object.keys(scalarValues),
    d1.name,
    r2.name,
    ai.name,
    email.name,
    ...durableObjects.map(({ name }) => name),
    // Another Worker's namespace (the Orb Worker's), bound only when that
    // provider is installed; the smoke runs without it.
    ...manifest.bindings
      .filter(({ crossScript }) => crossScript === true)
      .map(({ name }) => name),
  ]);
  if (
    accountedBindings.size !== manifest.bindings.length ||
    manifest.bindings.some(({ name }) => !accountedBindings.has(name))
  )
    throw new Error(
      "Package smoke cannot account for every production binding.",
    );
  const config = {
    name: "dx-production-package-smoke",
    main: workerMain,
    compatibility_date: "2026-08-20",
    compatibility_flags: ["nodejs_compat"],
    rules: [{ type: "ESModule", globs: ["**/*.js"] }],
    assets: {
      directory: assets,
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/v1", "/v1/*", "/healthz", "/readyz"],
    },
    vars: {
      ...scalarValues,
      [ai.name]: { kind: "synthetic-workers-ai", remote: false },
    },
    d1_databases: [
      {
        binding: d1.name,
        database_name: "dx-package-smoke",
        database_id: "00000000-0000-0000-0000-000000000000",
      },
    ],
    r2_buckets: [{ binding: r2.name, bucket_name: "dx-package-smoke" }],
    send_email: [
      {
        name: email.name,
        allowed_sender_addresses: [scalarValues.DX_AUTH_EMAIL_FROM],
      },
    ],
    durable_objects: {
      bindings: durableObjects.map(({ name, className }) => ({
        name,
        class_name: className,
      })),
    },
    migrations: migrations.durableObjects.map(({ tag, newSqliteClasses }) => ({
      tag,
      new_sqlite_classes: newSqliteClasses,
    })),
  };
  writeFileSync(resolve(smokeRoot, "wrangler.json"), JSON.stringify(config));

  const port = await availablePort();
  const child = spawn(
    resolve(workspaceRoot, "apps/core/node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      resolve(smokeRoot, "wrangler.json"),
      "--local",
      "--no-bundle",
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: smokeRoot,
      env: {
        CI: "1",
        HOME: smokeHome,
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors = `${errors}${chunk}`.slice(-4000);
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForWorker(origin, child);
    if (
      JSON.stringify(await health.json()) !==
      JSON.stringify({ status: "success", data: { state: "live" } })
    )
      throw new Error("Packaged Worker health response was not exact.");
    const application = await fetch(`${origin}/`);
    if (
      application.status !== 200 ||
      !(await application.text()).includes("<html")
    )
      throw new Error(
        "Packaged Worker did not serve the packaged application.",
      );
    const docsRedirect = await fetch(`${origin}/docs`, { redirect: "manual" });
    if (
      ![301, 302, 307, 308].includes(docsRedirect.status) ||
      new URL(docsRedirect.headers.get("location") ?? "", origin).pathname !==
        "/docs/"
    )
      throw new Error("Packaged Worker did not canonicalize /docs to /docs/.");
    const docs = await fetch(`${origin}/docs/`);
    const providerPages = await Promise.all(
      ["github-source", "bitbucket-source", "github-copilot"].map((page) =>
        fetch(`${origin}/docs/deployment/${page}/`),
      ),
    );
    const docsCssPath = manifest.files.find(
      ({ path }) =>
        path.startsWith("assets/docs/_astro/") && path.endsWith(".css"),
    )?.path;
    const docsJsPath = manifest.files.find(
      ({ path }) =>
        path.startsWith("assets/docs/_astro/") && path.endsWith(".js"),
    )?.path;
    const searchAssetPath = manifest.files.find(
      ({ path }) =>
        path.startsWith("assets/docs/pagefind/") && path.endsWith(".js"),
    )?.path;
    if (
      docs.status !== 200 ||
      !(await docs.text()).includes("<html") ||
      providerPages.some((response) => response.status !== 200) ||
      !(
        await Promise.all(providerPages.map((response) => response.text()))
      ).every((html) => html.includes("<html")) ||
      docsCssPath === undefined ||
      (await fetch(`${origin}/${docsCssPath.replace(/^assets\//, "")}`))
        .status !== 200 ||
      docsJsPath === undefined ||
      (await fetch(`${origin}/${docsJsPath.replace(/^assets\//, "")}`))
        .status !== 200 ||
      searchAssetPath === undefined ||
      (await fetch(`${origin}/${searchAssetPath.replace(/^assets\//, "")}`))
        .status !== 200
    )
      throw new Error(
        "Packaged Worker did not serve docs, provider deep links, and docs assets.",
      );
    const protectedRoute = await fetch(`${origin}/v1/projects`);
    if (protectedRoute.status !== 401)
      throw new Error("Packaged Worker did not route the protected API.");
    const discovery = await fetch(
      `${origin}/api/workload-identity/.well-known/openid-configuration`,
    );
    const jwks = await fetch(`${origin}/api/workload-identity/jwks.json`);
    if (
      discovery.status !== 200 ||
      (await discovery.json()).issuer !==
        scalarValues.DX_WORKLOAD_IDENTITY_ISSUER ||
      jwks.status !== 200 ||
      (await jwks.json()).keys?.[0]?.kid !== workloadIdentityKid
    )
      throw new Error(
        "Packaged Worker workload identity metadata was unavailable.",
      );
  } catch (error) {
    if (errors) console.error(errors);
    throw error;
  } finally {
    await stopSmokeChild(child);
    rmSync(smokeRoot, { recursive: true, force: true });
  }
  console.log(
    "Package evidence passed: exact packaged Worker loaded and routed health, static application, and protected API under workerd with synthetic bindings. This does not prove Cloudflare, E2B, resident dxd, or a model provider.",
  );
};

if (process.argv[1] === import.meta.filename) {
  const packageRoot = process.argv[2];
  if (packageRoot === undefined)
    throw new Error("Usage: smoke-production-package.mjs <package-directory>");
  await smokeProductionPackage(resolve(packageRoot));
}
