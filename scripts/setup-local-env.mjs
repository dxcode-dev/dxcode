import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = resolve(dirname(scriptPath), "..");

const readValue = (contents, name) => {
  const match = contents.match(new RegExp(`^${name}=(.*)$`, "m"));
  if (match === null) return undefined;
  const value = match[1].trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
};

const setValue = (contents, name, value, singleQuoted = false) => {
  const line = `${name}=${singleQuoted ? `'${value}'` : JSON.stringify(value)}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.trimEnd()}\n${line}\n`;
};

const isAllowedLocalAuthEmail = (value) => {
  if (typeof value !== "string") return false;
  const separator = value.lastIndexOf("@");
  return (
    separator > 0 && value.slice(separator + 1).toLowerCase() === "dx.local"
  );
};

const generatedDefaults = () => {
  const { privateKey: githubPrivateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const workloadIdentityKeyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const workloadIdentityKid = "local-key-0001";
  return {
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString("base64") },
    }),
    DX_INTEGRATION_GITHUB_APP: JSON.stringify({
      version: 1,
      appId: "1",
      appSlug: "dx-local",
      clientId: "local-client-id",
      clientSecret: randomBytes(24).toString("base64url"),
      privateKeyPem: githubPrivateKey.export({ type: "pkcs8", format: "pem" }),
      webhookSecret: randomBytes(32).toString("base64url"),
      callbackUrl:
        "http://localhost:3000/v1/integrations/github/oauth/callback",
      setupUrl: "http://localhost:3000/v1/integrations/github/setup",
      webhookUrl: "http://localhost:3000/v1/integrations/github/webhooks",
      expiringUserTokens: true,
      permissionManifestVersion: 1,
      repositoryPermissions: {
        actions: "write",
        checks: "read",
        contents: "write",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
        workflows: "write",
      },
      organizationPermissions: { projects: "write" },
      events: ["repository"],
    }),
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
    DX_LOCAL_AUTH_NAME: "Codex Developer",
    DX_LOCAL_AUTH_EMAIL: "codex-local@dx.local",
    DX_LOCAL_AUTH_PASSWORD: randomBytes(24).toString("base64url"),
  };
};

const prepareFile = (
  path,
  examplePath,
  sharedCredentials,
  synchronize = false,
) => {
  if (!existsSync(path)) copyFileSync(examplePath, path);
  let contents = readFileSync(path, "utf8");
  const defaults = { ...generatedDefaults(), ...sharedCredentials };

  const authSecret = readValue(contents, "BETTER_AUTH_SECRET");
  if (
    authSecret === undefined ||
    authSecret === "replace-with-at-least-32-random-characters"
  ) {
    contents = setValue(
      contents,
      "BETTER_AUTH_SECRET",
      defaults.BETTER_AUTH_SECRET,
    );
  }

  let encryptionKeys = readValue(contents, "DX_CONFIG_ENCRYPTION_KEYS");
  if (
    encryptionKeys === undefined ||
    encryptionKeys.includes("replace-with-base64-32-byte-key")
  ) {
    encryptionKeys = defaults.DX_CONFIG_ENCRYPTION_KEYS;
  }
  contents = setValue(
    contents,
    "DX_CONFIG_ENCRYPTION_KEYS",
    encryptionKeys,
    true,
  );

  const workloadIdentitySigningKeys = readValue(
    contents,
    "DX_WORKLOAD_IDENTITY_SIGNING_KEYS",
  );
  if (
    workloadIdentitySigningKeys === undefined ||
    workloadIdentitySigningKeys.includes(
      "replace-with-workload-identity-keyring",
    )
  ) {
    contents = setValue(
      contents,
      "DX_WORKLOAD_IDENTITY_SIGNING_KEYS",
      defaults.DX_WORKLOAD_IDENTITY_SIGNING_KEYS,
      true,
    );
  }

  const githubApp = readValue(contents, "DX_INTEGRATION_GITHUB_APP");
  if (
    githubApp === undefined ||
    githubApp.includes("replace-with-github-app-private-key-pem")
  ) {
    contents = setValue(
      contents,
      "DX_INTEGRATION_GITHUB_APP",
      defaults.DX_INTEGRATION_GITHUB_APP,
      true,
    );
  }

  if (!isAllowedLocalAuthEmail(readValue(contents, "DX_LOCAL_AUTH_EMAIL"))) {
    contents = setValue(
      contents,
      "DX_LOCAL_AUTH_EMAIL",
      defaults.DX_LOCAL_AUTH_EMAIL,
    );
  }

  for (const name of [
    "DX_LOCAL_AUTH_NAME",
    "DX_LOCAL_AUTH_EMAIL",
    "DX_LOCAL_AUTH_PASSWORD",
  ]) {
    if (synchronize || readValue(contents, name) === undefined) {
      contents = setValue(contents, name, defaults[name]);
    }
  }
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return Object.fromEntries(
    ["DX_LOCAL_AUTH_NAME", "DX_LOCAL_AUTH_EMAIL", "DX_LOCAL_AUTH_PASSWORD"].map(
      (name) => [name, readValue(contents, name)],
    ),
  );
};

export const setupLocalEnvironment = (workspaceRoot = defaultWorkspaceRoot) => {
  const examplePath = resolve(workspaceRoot, "apps/core/.dev.vars.example");
  const destinationPath = resolve(workspaceRoot, "apps/core/.dev.vars");
  prepareFile(destinationPath, examplePath, {});
  return { destinationPath, copiedFrom: destinationPath };
};

export const synchronizeLocalGitHubAppOrigin = (
  workspaceRoot = defaultWorkspaceRoot,
  webOrigin,
) => {
  const origin = new URL(webOrigin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.pathname !== "/" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== ""
  )
    throw new Error("Local Web origin must be an IPv4 loopback HTTP root.");
  const destinationPath = resolve(workspaceRoot, "apps/core/.dev.vars");
  let contents = readFileSync(destinationPath, "utf8");
  const encoded = readValue(contents, "DX_INTEGRATION_GITHUB_APP");
  if (encoded === undefined)
    throw new Error("Missing local GitHub App configuration.");
  const configuration = JSON.parse(encoded);
  const synchronized = JSON.stringify({
    ...configuration,
    callbackUrl: new URL(
      "/v1/integrations/github/oauth/callback",
      origin,
    ).toString(),
    setupUrl: new URL("/v1/integrations/github/setup", origin).toString(),
    webhookUrl: new URL("/v1/integrations/github/webhooks", origin).toString(),
  });
  contents = setValue(
    contents,
    "DX_INTEGRATION_GITHUB_APP",
    synchronized,
    true,
  );
  writeFileSync(destinationPath, contents, { mode: 0o600 });
  chmodSync(destinationPath, 0o600);
  return synchronized;
};

if (process.argv[1] === scriptPath) {
  const result = setupLocalEnvironment();
  const source =
    result.copiedFrom === result.destinationPath
      ? "created or reused locally"
      : `shared from ${result.copiedFrom}`;
  console.log(`Local development configuration ready (${source}).`);
}
