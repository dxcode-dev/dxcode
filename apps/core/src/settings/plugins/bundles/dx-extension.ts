import {
  MAX_PLUGIN_AGENT_MODES,
  MAX_PLUGIN_CODE_MODELS,
  MAX_PLUGIN_CODE_MODULE_BYTES,
  MAX_PLUGIN_CODE_MODULES,
  MAX_PLUGIN_CODE_TOTAL_BYTES,
  PLUGIN_CODE_EVENTS,
  PLUGIN_CODE_THREAD_GRANTS,
  PLUGIN_CODE_UI_GRANTS,
  PluginAgentMode,
  PluginCodeModel,
  PluginCodePermissions,
  PluginCodeSetting,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { type BundleFolder, isRecord, manifestPath } from "./bundle-reader.js";

/**
 * Reads dx's namespace in an Agent Plugins manifest,
 * `extensions["dev.dxcode"]`: the code layer's entry module, the permissions
 * its code asks for, and the settings the installer fills. Nothing here runs.
 * A malformed block turns off only dx's layers: the reason is listed as
 * skipped and the portable layer (skills, MCP servers) still loads.
 */

export const DX_EXTENSION_NAMESPACE = "dev.dxcode";

/** Code lives in this folder at the plugin root. */
const CODE_FOLDER = DX_EXTENSION_NAMESPACE;

const blockFields = new Set([
  "apiVersion",
  "entry",
  "host",
  "permissions",
  "settings",
  "agentModes",
]);

const permissionFields = new Set([
  "events",
  "network",
  "secrets",
  "tools",
  "ai",
  "ui",
  "threads",
  "models",
  "agents",
  "shell",
]);

const isModule = (path: string) => /\.m?js$/.test(path);

export interface PluginCodeModule {
  readonly path: string;
  readonly content: string;
}

export interface ReadPluginCode {
  readonly apiVersion: 1;
  readonly host: "worker";
  readonly entry: string;
  readonly permissions: PluginCodePermissions;
  readonly settings: ReadonlyArray<PluginCodeSetting>;
  readonly agentModes?: ReadonlyArray<PluginAgentMode>;
  /** Every JavaScript module under `dev.dxcode/`, entry first. */
  readonly modules: ReadonlyArray<PluginCodeModule>;
}

const stringList = (value: unknown): ReadonlyArray<string> | undefined =>
  value === undefined
    ? []
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : undefined;

export const readDxExtension = Effect.fn("readDxExtension")(function* (
  folder: BundleFolder,
  block: unknown,
) {
  const label = `plugin.json#extensions.${DX_EXTENSION_NAMESPACE}`;
  const off = (reason: string) => {
    folder.skip(label, `${reason} dx's code layer is off for this plugin.`);
    return undefined;
  };
  if (block === undefined) {
    if (folder.under(CODE_FOLDER).length > 0)
      folder.skip(
        `${CODE_FOLDER}/`,
        `plugin.json has no extensions.${DX_EXTENSION_NAMESPACE} block naming an entry module.`,
      );
    return undefined;
  }
  if (!isRecord(block)) return off("The block is not an object.");
  for (const field of Object.keys(block))
    if (!blockFields.has(field))
      folder.skip(`${label}.${field}`, "Not a dx field; ignored.");
  if (block.apiVersion !== 1)
    return off("apiVersion must be 1, the plugin API version dx supports.");
  const host = block.host ?? "worker";
  if (host !== "worker")
    return off(
      host === "orb"
        ? "The Orb host is not available yet; use host worker."
        : "host must be worker.",
    );
  if (typeof block.entry !== "string")
    return off("entry must name the code's entry module.");
  const entry = manifestPath(block.entry);
  if (entry === "outside" || entry === "")
    return off("entry must be a file inside the plugin.");
  if (!entry.startsWith(`${CODE_FOLDER}/`))
    return off(`entry must be inside the ${CODE_FOLDER}/ folder.`);
  if (/\.(?:ts|mts|tsx)$/.test(entry))
    return off(
      "dx runs JavaScript. Build the TypeScript entry to a .js module and point entry at it.",
    );
  if (!isModule(entry)) return off("entry must be a .js or .mjs module.");
  if (!folder.files.has(entry)) return off(`${entry} is missing.`);

  // Permissions: every list is checked whole; a bad one turns the layer off,
  // since a narrower grant than the author meant would run code half-blind.
  const rawPermissions = block.permissions ?? {};
  if (!isRecord(rawPermissions)) return off("permissions is not an object.");
  for (const field of Object.keys(rawPermissions))
    if (!permissionFields.has(field))
      folder.skip(
        `${label}.permissions.${field}`,
        "dx does not grant this permission yet; ignored.",
      );
  const events = stringList(rawPermissions.events);
  const network = stringList(rawPermissions.network);
  const secrets = stringList(rawPermissions.secrets);
  const tools = stringList(rawPermissions.tools);
  const ui = stringList(rawPermissions.ui);
  const models = stringList(rawPermissions.models);
  if (
    models === undefined ||
    events === undefined ||
    network === undefined ||
    secrets === undefined ||
    tools === undefined ||
    ui === undefined
  )
    return off("Each permission list must be a list of text.");
  const unknownEvents = events.filter(
    (event) => !(PLUGIN_CODE_EVENTS as ReadonlyArray<string>).includes(event),
  );
  if (unknownEvents.length > 0)
    return off(
      `dx has no event named ${unknownEvents.join(", ")}. Events: ${PLUGIN_CODE_EVENTS.join(", ")}.`,
    );
  const unknownUi = ui.filter(
    (grant) =>
      !(PLUGIN_CODE_UI_GRANTS as ReadonlyArray<string>).includes(grant),
  );
  if (unknownUi.length > 0)
    return off(
      `dx has no UI permission named ${unknownUi.join(", ")}. UI permissions: ${PLUGIN_CODE_UI_GRANTS.join(", ")}.`,
    );
  if (rawPermissions.ai !== undefined && typeof rawPermissions.ai !== "boolean")
    return off("permissions.ai must be true or false.");
  // `true` is the original form and means ["create"]; a list names grants.
  const threadGrants =
    typeof rawPermissions.threads === "boolean" ||
    rawPermissions.threads === undefined
      ? undefined
      : stringList(rawPermissions.threads);
  if (
    rawPermissions.threads !== undefined &&
    typeof rawPermissions.threads !== "boolean" &&
    threadGrants === undefined
  )
    return off(
      `permissions.threads must be true or a list of ${PLUGIN_CODE_THREAD_GRANTS.join(", ")}.`,
    );
  const unknownThreads = (threadGrants ?? []).filter(
    (grant) =>
      !(PLUGIN_CODE_THREAD_GRANTS as ReadonlyArray<string>).includes(grant),
  );
  if (unknownThreads.length > 0)
    return off(
      `dx has no Thread permission named ${unknownThreads.join(", ")}. Thread permissions: ${PLUGIN_CODE_THREAD_GRANTS.join(", ")}.`,
    );
  if (
    rawPermissions.agents !== undefined &&
    typeof rawPermissions.agents !== "boolean"
  )
    return off("permissions.agents must be true or false.");
  const badModels = models.filter(
    (model) => !Schema.is(PluginCodeModel)(model),
  );
  if (badModels.length > 0)
    return off(
      `permissions.models lists ${badModels.join(", ")}: name each as provider/model, such as anthropic/claude-sonnet-5-5, or as a dx mode: low, medium, high, or ultra.`,
    );
  if (new Set(models).size > MAX_PLUGIN_CODE_MODELS)
    return off(
      `permissions.models lists more than ${MAX_PLUGIN_CODE_MODELS} models.`,
    );
  if (
    rawPermissions.shell !== undefined &&
    typeof rawPermissions.shell !== "boolean"
  )
    return off("permissions.shell must be true or false.");
  const permissions = Schema.decodeUnknownOption(PluginCodePermissions)({
    events: [...new Set(events)],
    network: [...new Set(network.map((host) => host.toLowerCase()))],
    secrets: [...new Set(secrets)],
    tools: [...new Set(tools)],
    ai: rawPermissions.ai === true,
    ...(ui.length === 0 ? {} : { ui: [...new Set(ui)] }),
    ...(rawPermissions.threads === true
      ? { threads: true }
      : threadGrants !== undefined && threadGrants.length > 0
        ? {
            threads: PLUGIN_CODE_THREAD_GRANTS.filter((grant) =>
              threadGrants.includes(grant),
            ),
          }
        : {}),
    ...(models.length === 0 ? {} : { models: [...new Set(models)] }),
    ...(rawPermissions.agents === true ? { agents: true } : {}),
    ...(rawPermissions.shell === true ? { shell: true } : {}),
  });
  if (Option.isNone(permissions))
    return off(
      "A permission is malformed: network lists host names, secrets and tools list names.",
    );

  const rawSettings = block.settings ?? [];
  if (!Array.isArray(rawSettings)) return off("settings must be a list.");
  const settings: Array<PluginCodeSetting> = [];
  for (const raw of rawSettings) {
    const setting = Schema.decodeUnknownOption(PluginCodeSetting)(
      isRecord(raw) ? { required: false, type: "string", ...raw } : raw,
    );
    if (Option.isNone(setting))
      return off(
        "Each setting needs a key, a label, and a type of string, number, or boolean.",
      );
    if (settings.some(({ key }) => key === setting.value.key))
      return off(`Two settings share the key ${setting.value.key}.`);
    if (
      setting.value.default !== undefined &&
      typeof setting.value.default !==
        (setting.value.type === "string" ? "string" : setting.value.type)
    )
      return off(`The default for ${setting.value.key} is not its type.`);
    settings.push(setting.value);
  }

  // Agent modes: declared here so dx lists and reviews them without running
  // the code; the code registers each with dx.registerAgentMode.
  const rawModes = block.agentModes ?? [];
  if (!Array.isArray(rawModes)) return off("agentModes must be a list.");
  if (rawModes.length > MAX_PLUGIN_AGENT_MODES)
    return off(
      `A plugin declares at most ${MAX_PLUGIN_AGENT_MODES} agent modes.`,
    );
  const agentModes: Array<PluginAgentMode> = [];
  for (const raw of rawModes) {
    const mode = Schema.decodeUnknownOption(PluginAgentMode)(raw);
    if (Option.isNone(mode))
      return off(
        "Each agent mode needs a key (1 to 24 lowercase letters, digits, and hyphens), a label of at most 24 characters, and optionally a description and a #rrggbb color.",
      );
    if (agentModes.some(({ key }) => key === mode.value.key))
      return off(`Two agent modes share the key ${mode.value.key}.`);
    agentModes.push(mode.value);
  }
  if (agentModes.length > 0 && permissions.value.agents !== true)
    return off("agentModes needs permissions.agents set to true.");

  // Modules: every JavaScript file under dev.dxcode/, so relative imports
  // resolve; other files there (views) are for later milestones.
  const modulePaths = [
    entry,
    ...folder
      .under(CODE_FOLDER)
      .filter((path) => path !== entry && isModule(path))
      .sort(),
  ];
  for (const path of folder.under(CODE_FOLDER))
    if (!isModule(path))
      folder.skip(path, "Only JavaScript modules in dev.dxcode/ load today.");
  if (modulePaths.length > MAX_PLUGIN_CODE_MODULES)
    return off(
      `The code has more than ${MAX_PLUGIN_CODE_MODULES} modules; bundle it into fewer files.`,
    );
  const modules: Array<PluginCodeModule> = [];
  let total = 0;
  for (const path of modulePaths) {
    const text = yield* folder.read(path, MAX_PLUGIN_CODE_MODULE_BYTES);
    if (!text.ok) return off(`${path}: ${text.reason}`);
    total += new TextEncoder().encode(text.text).byteLength;
    if (total > MAX_PLUGIN_CODE_TOTAL_BYTES)
      return off(
        `The code is larger than ${MAX_PLUGIN_CODE_TOTAL_BYTES.toLocaleString("en-US")} bytes.`,
      );
    modules.push({ path, content: text.text });
  }
  return {
    apiVersion: 1,
    host: "worker",
    entry,
    permissions: permissions.value,
    settings,
    ...(agentModes.length === 0 ? {} : { agentModes }),
    modules,
  } satisfies ReadPluginCode;
});
