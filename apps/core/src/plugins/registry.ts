import {
  EXECUTION_CAPABILITY_IDS,
  type ExecutionPauseResumePreserves,
  type FirstPartyPluginId,
  type PluginCapabilityId,
  type PluginMeteringUnit,
  type PluginProviderId,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";

export type ConfigurableProviderId = Exclude<PluginProviderId, "fixture">;

export interface ProviderDefinition {
  readonly id: ConfigurableProviderId;
  readonly displayName: string;
  /**
   * A shorter name for compact places, such as the new-Thread Orb picker;
   * settings pages keep `displayName`. Defaults to `displayName`.
   */
  readonly shortName?: string;
  readonly capabilities: ReadonlyArray<PluginCapabilityId>;
  /**
   * The key a person or workspace types. Null means the provider cannot be
   * configured at those scopes: it is built in, or deployment scope only.
   */
  readonly credentialLabel: string | null;
  /** Optional deployment-scope secret binding. */
  readonly deploymentSecret?: "EXA_API_KEY" | "SARVAM_API_KEY" | "E2B_API_KEY";
  /**
   * A keyless provider the deployment installs explicitly: it resolves when
   * this binding is present. Cloudflare Containers runs in the deployer's own
   * account, so its Durable Object namespace binding is the installation.
   */
  readonly deploymentBinding?: "ORB_CONTAINER";
  /**
   * What `execution.pause-resume` keeps across a pause; required exactly
   * when the provider claims that capability.
   */
  readonly pauseResumePreserves?: ExecutionPauseResumePreserves;
  /**
   * The development provider: local runtime selects it instead of the
   * fixture, and deployed runtime never selects it.
   */
  readonly development?: true;
  /** What each call reports to `plugin_usage_event`; null when unmetered. */
  readonly unit: PluginMeteringUnit | null;
}

export interface PluginDefinition {
  readonly id: FirstPartyPluginId;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: ReadonlyArray<PluginCapabilityId>;
  readonly providers: ReadonlyArray<ProviderDefinition>;
  /**
   * Always installed and never disabled at any scope. Code is always on
   * because it is the only path to MCP servers; only its provider can change.
   */
  readonly alwaysOn?: true;
  /**
   * Resolved once per Thread rather than per submission, and never part of a
   * submission's tool set. Execution: the workspace is fixed for a Thread's
   * lifetime and its tools mount with the workspace.
   */
  readonly resolvedPerThread?: true;
}

/** First-party catalog: plugin → capabilities → providers. */
export const FIRST_PARTY_PLUGINS: ReadonlyArray<PluginDefinition> = [
  {
    id: "search",
    displayName: "Web search",
    description:
      "Lets the agent search the public web and read public pages with cited sources.",
    capabilities: ["web.search", "web.read"],
    providers: [
      {
        id: "exa",
        displayName: "Exa",
        capabilities: ["web.search", "web.read"],
        credentialLabel: "Exa API key",
        deploymentSecret: "EXA_API_KEY",
        unit: "request",
      },
    ],
  },
  {
    id: "speech",
    displayName: "Dictation",
    description:
      "Turns speech recorded in the composer into text you can edit before sending.",
    capabilities: ["speech.transcribe"],
    providers: [
      {
        id: "sarvam",
        displayName: "Sarvam",
        capabilities: ["speech.transcribe"],
        credentialLabel: "Sarvam API key",
        deploymentSecret: "SARVAM_API_KEY",
        unit: "audio_second",
      },
    ],
  },
  {
    id: "code",
    displayName: "Code",
    description:
      "Runs isolated JavaScript for the agent, and is how it calls the reviewed tools of connected MCP servers. Always on; no filesystem or network access.",
    capabilities: ["code.execute"],
    alwaysOn: true,
    providers: [
      {
        id: "quickjs",
        displayName: "QuickJS",
        capabilities: ["code.execute"],
        credentialLabel: null,
        unit: "request",
      },
    ],
  },
  {
    id: "execution",
    displayName: "Orb",
    description:
      "The isolated workspace each Thread runs in: files, commands, and the terminal. Required; configured by the deployment.",
    capabilities: EXECUTION_CAPABILITY_IDS,
    // A required slot: always installed, never disabled, and readiness fails
    // closed when no deployment provider resolves.
    alwaysOn: true,
    resolvedPerThread: true,
    providers: [
      {
        id: "e2b",
        displayName: "E2B",
        // Claims only what dx implements on E2B today. E2B's snapshot and
        // metrics APIs back execution.snapshot and execution.usage later.
        capabilities: [
          "execution.workspace",
          "execution.resident-daemon",
          "execution.pause-resume",
        ],
        // People and workspaces may bring their own E2B team (4b); the
        // Orb Providers page owns those keys and builds the Orb template
        // into that team.
        credentialLabel: "E2B API key",
        deploymentSecret: "E2B_API_KEY",
        // A paused sandbox keeps its processes and memory.
        pauseResumePreserves: "processes",
        // Sandbox seconds are not metered yet; see
        // wiki/plugin-platform-direction.md "What phase 4 shipped".
        unit: null,
      },
      {
        id: "cloudflare",
        displayName: "Cloudflare Containers",
        shortName: "Cloudflare",
        // One container per Thread, owned by a Durable Object in the
        // deployer's account; deployment scope only (no key to bring).
        capabilities: [
          "execution.workspace",
          "execution.resident-daemon",
          "execution.pause-resume",
        ],
        credentialLabel: null,
        deploymentBinding: "ORB_CONTAINER",
        // A pause snapshots the filesystem and stops the container;
        // processes restart from the image entrypoint on wake.
        pauseResumePreserves: "filesystem",
        unit: null,
      },
      {
        id: "local",
        displayName: "Local runtime",
        capabilities: ["execution.workspace", "execution.resident-daemon"],
        credentialLabel: null,
        development: true,
        unit: null,
      },
    ],
  },
];

export const findPlugin = (pluginId: string): PluginDefinition | undefined =>
  FIRST_PARTY_PLUGINS.find(({ id }) => id === pluginId);

export const findProvider = (
  plugin: PluginDefinition,
  providerId: string,
): ProviderDefinition | undefined =>
  plugin.providers.find(({ id }) => id === providerId);

export const isLocalRuntime = (bindings: Bindings) =>
  bindings.DX_RUNTIME_MODE !== "deployed";

/**
 * Installation is deployment scope: `DX_INSTALLED_PLUGINS` lists plugin IDs,
 * comma-separated. Hosted deployments list every first-party plugin;
 * self-host lists the plugins chosen at `pnpm dx:deploy`. Unknown IDs are
 * ignored. Always-on plugins are installed whatever the binding says.
 */
export const installedPlugins = (
  bindings: Bindings,
): ReadonlyArray<PluginDefinition> => {
  const listed = new Set(
    (bindings.DX_INSTALLED_PLUGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return FIRST_PARTY_PLUGINS.filter(
    ({ id, alwaysOn }) => alwaysOn === true || listed.has(id),
  );
};

/**
 * The deployment-scope configuration from bindings. Built-in providers need
 * no secret. Local runtime uses the plugin's development provider, else the
 * fixture, for external providers.
 */
export const deploymentProvider = (
  plugin: PluginDefinition,
  bindings: Bindings,
): PluginProviderId | undefined => deploymentProviders(plugin, bindings)[0];

/**
 * Every deployment-scope provider that resolves, in registry order. Most
 * plugins resolve to one; Execution resolves to the set a deployment
 * installed (E2B and Cloudflare Containers can be installed side by side),
 * and each Thread pins one of them through its runner profile.
 */
export const deploymentProviders = (
  plugin: PluginDefinition,
  bindings: Bindings,
): ReadonlyArray<PluginProviderId> => {
  const builtIn = plugin.providers.find(
    (provider) =>
      provider.credentialLabel === null &&
      provider.deploymentSecret === undefined &&
      provider.deploymentBinding === undefined &&
      provider.development !== true,
  );
  if (builtIn !== undefined) return [builtIn.id];
  if (isLocalRuntime(bindings))
    return [
      plugin.providers.find((provider) => provider.development === true)?.id ??
        "fixture",
    ];
  return plugin.providers
    .filter(
      (provider) =>
        (provider.deploymentSecret !== undefined &&
          (bindings[provider.deploymentSecret] ?? "").trim() !== "") ||
        (provider.deploymentBinding !== undefined &&
          bindings[provider.deploymentBinding] !== undefined),
    )
    .map(({ id }) => id);
};

export const providerCapabilities = (
  plugin: PluginDefinition,
  providerId: PluginProviderId,
): ReadonlyArray<PluginCapabilityId> =>
  providerId === "fixture"
    ? plugin.capabilities
    : (findProvider(plugin, providerId)?.capabilities ?? []);
