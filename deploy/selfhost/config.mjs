import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_KEYS = new Set([
  "version",
  "name",
  "cloudflareAccountId",
  "domain",
  "zone",
  "authEmailFrom",
  "adminEmail",
  "allowSignup",
  "workersAi",
  "workerTraces",
  "githubCopilotClientId",
  "modelDeploymentProviders",
  "modelEndpointAllowlist",
  "dxdBinary",
  "integrations",
  "plugins",
  "offeredPlugins",
  "orbProviders",
]);

/**
 * Orb (Execution) providers a deployment may install; at least one. E2B needs
 * an API key. Cloudflare Containers needs no key but runs, and is billed, in
 * the deployment's own Cloudflare account (Workers Paid plan), and deploying
 * it builds the Orb image with Docker.
 */
export const ORB_PROVIDER_IDS = Object.freeze(["e2b", "cloudflare"]);

export const DEPLOYMENT_SECRET_NAMES = Object.freeze([
  "DX_ADMIN_PASSWORD",
  "E2B_API_KEY",
  "DX_INTEGRATION_GITHUB_APP",
  "DX_INTEGRATION_BITBUCKET_OAUTH",
  "SARVAM_API_KEY",
  "EXA_API_KEY",
]);

/**
 * First-party plugins an installer may choose; hosted dx installs all. Code is
 * always installed and is not a choice.
 */
export const FIRST_PARTY_PLUGIN_IDS = Object.freeze(["search", "speech"]);

/** Each optional provider key belongs to one plugin's deployment scope. */
const PLUGIN_INTEGRATIONS = Object.freeze({ exa: "search", sarvam: "speech" });

const pluginList = (value, label) => {
  if (
    !Array.isArray(value) ||
    value.some((id) => !FIRST_PARTY_PLUGIN_IDS.includes(id)) ||
    new Set(value).size !== value.length
  )
    throw new Error(
      `${label} may contain ${FIRST_PARTY_PLUGIN_IDS.join(", ")} once each.`,
    );
  return value;
};

const optionalString = (value, label) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be a non-empty string when configured.`);
  return value.trim();
};

export const validateSelfhostConfig = (input) => {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("deploy.selfhost.json must contain one JSON object.");
  const unknown = Object.keys(input).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0)
    throw new Error(
      `deploy.selfhost.json contains unsupported or secret keys: ${unknown.join(", ")}.`,
    );
  if (input.version !== undefined && input.version !== 1)
    throw new Error("deploy.selfhost.json version must be 1.");
  const name = optionalString(input.name, "name");
  if (!name || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(name))
    throw new Error(
      "name must be 2-40 lowercase letters, numbers, or hyphens.",
    );
  const adminEmail = optionalString(input.adminEmail, "adminEmail");
  if (!adminEmail || !/^[^\s@]+@[^\s@]+$/.test(adminEmail))
    throw new Error("adminEmail must be a valid email address.");
  const cloudflareAccountId = optionalString(
    input.cloudflareAccountId,
    "cloudflareAccountId",
  );
  if (
    cloudflareAccountId !== undefined &&
    !/^[a-f0-9]{32}$/.test(cloudflareAccountId)
  )
    throw new Error("cloudflareAccountId must be a 32-character account ID.");
  const domain = optionalString(input.domain, "domain");
  const zone = optionalString(input.zone, "zone");
  if ((domain === undefined) !== (zone === undefined))
    throw new Error("domain and zone must be configured together.");
  if (domain !== undefined) {
    let hostname;
    try {
      hostname = new URL(`https://${domain}`).hostname;
    } catch {
      throw new Error("domain must be a bare hostname.");
    }
    if (
      hostname !== domain ||
      (domain !== zone && !domain.endsWith(`.${zone}`))
    )
      throw new Error("domain must be a bare hostname inside zone.");
  }
  const authEmailFrom = optionalString(input.authEmailFrom, "authEmailFrom");
  const authEmailDomain = authEmailFrom?.split("@")[1]?.toLowerCase();
  if (
    authEmailFrom !== undefined &&
    (!/^[^\s@]+@[^\s@]+$/.test(authEmailFrom) ||
      zone === undefined ||
      (authEmailDomain !== zone.toLowerCase() &&
        !authEmailDomain?.endsWith(`.${zone.toLowerCase()}`)))
  )
    throw new Error(
      "authEmailFrom must be an email address inside the deployment zone.",
    );
  for (const key of ["allowSignup", "workersAi", "workerTraces"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new Error(`${key} must be true or false.`);
  const integrations = input.integrations ?? [];
  if (
    !Array.isArray(integrations) ||
    integrations.some(
      (value) => !new Set(["github", "bitbucket", "sarvam", "exa"]).has(value),
    ) ||
    new Set(integrations).size !== integrations.length
  )
    throw new Error(
      "integrations may contain github, bitbucket, sarvam, and exa once each.",
    );
  // Configs written before Containers existed installed E2B.
  const orbProviders = input.orbProviders ?? ["e2b"];
  if (
    !Array.isArray(orbProviders) ||
    orbProviders.length === 0 ||
    orbProviders.some((value) => !ORB_PROVIDER_IDS.includes(value)) ||
    new Set(orbProviders).size !== orbProviders.length
  )
    throw new Error(
      "orbProviders must contain e2b, cloudflare, or both, once each.",
    );
  let plugins = [...pluginList(input.plugins ?? [], "plugins")];
  // Plugins the installer has asked about; an installed plugin was asked
  // about. Configs written before this key existed were asked about Search
  // only, and only if they record `plugins`.
  let offered = [
    ...new Set([
      ...pluginList(
        input.offeredPlugins ?? (input.plugins === undefined ? [] : ["search"]),
        "offeredPlugins",
      ),
      ...plugins,
    ]),
  ];
  // Before Speech was a plugin, the `sarvam` integration alone turned on
  // dictation. Such deployments keep it: Speech is installed and counts as
  // asked, so the installer does not ask again.
  if (!offered.includes("speech") && integrations.includes("sarvam")) {
    if (!plugins.includes("speech")) plugins = [...plugins, "speech"];
    offered = [...offered, "speech"];
  }
  // Each provider key is its plugin's deployment-scope configuration.
  for (const [integration, plugin] of Object.entries(PLUGIN_INTEGRATIONS))
    if (integrations.includes(integration) && !plugins.includes(plugin))
      throw new Error(
        `The ${integration} integration requires the ${plugin} plugin.`,
      );
  return Object.freeze({
    version: 1,
    name,
    ...(cloudflareAccountId === undefined ? {} : { cloudflareAccountId }),
    adminEmail: adminEmail.toLowerCase(),
    ...(domain === undefined ? {} : { domain, zone }),
    ...(authEmailFrom === undefined
      ? {}
      : { authEmailFrom: authEmailFrom.toLowerCase() }),
    allowSignup: input.allowSignup === true,
    workersAi: input.workersAi !== false,
    // Absent means the operator was never asked; the installer asks once.
    ...(input.workerTraces === undefined
      ? {}
      : { workerTraces: input.workerTraces }),
    integrations: [...integrations].sort(),
    orbProviders: [...orbProviders].sort(),
    // Absent means the operator was never asked; the installer asks once
    // about each plugin not yet offered.
    ...(offered.length === 0
      ? {}
      : {
          plugins: [...plugins].sort(),
          offeredPlugins: [...offered].sort(),
        }),
    ...Object.fromEntries(
      [
        "githubCopilotClientId",
        "modelDeploymentProviders",
        "modelEndpointAllowlist",
        "dxdBinary",
      ].flatMap((key) => {
        const value = optionalString(input[key], key);
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  });
};

export const loadSelfhostDeploymentConfig = (
  path = "deploy.selfhost.json",
  root = process.cwd(),
) => {
  let input;
  try {
    input = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (cause) {
    if (cause instanceof SyntaxError)
      throw new Error(`${path} is not valid JSON.`);
    throw cause;
  }
  return validateSelfhostConfig(input);
};

export const secretEnvironment = (environment) =>
  Object.fromEntries(
    DEPLOYMENT_SECRET_NAMES.flatMap((name) => {
      const value = environment[name];
      return typeof value === "string" && value.length > 0
        ? [[name, value]]
        : [];
    }),
  );
