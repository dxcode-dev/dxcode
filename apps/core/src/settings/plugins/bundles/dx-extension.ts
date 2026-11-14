import {
  MAX_PLUGIN_AGENT_MODES,
  MAX_PLUGIN_BINARIES,
  MAX_PLUGIN_CODE_MODELS,
  MAX_PLUGIN_CODE_MODULE_BYTES,
  MAX_PLUGIN_CODE_MODULES,
  MAX_PLUGIN_CODE_TOTAL_BYTES,
  MAX_PLUGIN_JOBS,
  MAX_PLUGIN_MANIFEST_PANES,
  PLUGIN_ARCHIVED_MODES,
  PLUGIN_CODE_EVENTS,
  PLUGIN_CODE_THREAD_GRANTS,
  PLUGIN_CODE_UI_GRANTS,
  PLUGIN_DURABLE_SCOPES,
  PLUGIN_HOST_KINDS,
  PluginAgentMode,
  type PluginArchivedMode,
  PluginCodeBinary,
  type PluginCodeHosts,
  PluginCodeModel,
  PluginCodePermissions,
  PluginCodeSetting,
  type PluginDurableScope,
  type PluginExport,
  type PluginHostKind,
  PluginJob,
  type PluginManifestPane,
  type PluginPaneConnect,
  PluginTier,
  type PluginViews,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { everyMs, parseCron } from "../../../plugins/hosts/durable/schedule.js";
import { lucideIconExists } from "../../../plugins/icons/lucide.js";
import { readPaneConnect } from "../../../plugins/streams/pane-connect.js";
import {
  type BundleFolder,
  isRecord,
  manifestPath,
  skipUnknownFields,
} from "./bundle-reader.js";
import { readDxCallTargets, readDxExports, readDxViews } from "./dx-views.js";
import {
  type PluginIconFile,
  readItemIcon,
  readItemIconAssets,
} from "./plugin-icon.js";

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
  "tier",
  "binaries",
  "icon",
  "archivedThreads",
  "panes",
  "views",
  "exports",
  "durableScope",
  "jobs",
]);

/** A manifest pane's fields; `connect` is read by `readPaneConnect`. */
const paneFields = ["id", "title", "icon", "archivedThreads", "connect"];
const paneConnectFields = ["hosts", "portal", "webrtc"];
const jobScheduleFields = ["every", "cron", "at"];

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
  "plugins",
  "wake",
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
  /** Entry modules per host, when the manifest used the object form. */
  readonly hosts?: PluginCodeHosts;
  readonly durableScope?: PluginDurableScope;
  readonly jobs?: ReadonlyArray<PluginJob>;
  readonly permissions: PluginCodePermissions;
  readonly settings: ReadonlyArray<PluginCodeSetting>;
  readonly agentModes?: ReadonlyArray<PluginAgentMode>;
  /** The manifest's `tier`: the highest tier the author asks for. */
  readonly tier?: PluginTier;
  /** Native tools for the Orb and container hosts. */
  readonly binaries?: ReadonlyArray<PluginCodeBinary>;
  /** Tabs, pages, and Thread types. */
  readonly views?: PluginViews;
  /** Functions other plugins may call. */
  readonly exports?: ReadonlyArray<PluginExport>;
  /** `panes[].connect`, each host within `permissions.network`. */
  readonly paneConnect?: ReadonlyArray<PluginPaneConnect>;
  /** Every JavaScript module under `dev.dxcode/`, entry first. */
  readonly modules: ReadonlyArray<PluginCodeModule>;
  readonly archivedThreads?: PluginArchivedMode;
  readonly panes?: ReadonlyArray<PluginManifestPane>;
  readonly iconAssets?: Readonly<Record<string, string>>;
  /** Item icon files to store by hash. */
  readonly iconFiles?: ReadonlyArray<PluginIconFile>;
}

const isArchivedMode = (value: unknown): value is PluginArchivedMode =>
  (PLUGIN_ARCHIVED_MODES as ReadonlyArray<unknown>).includes(value);

const stringList = (value: unknown): ReadonlyArray<string> | undefined =>
  value === undefined
    ? []
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : undefined;

/**
 * Whether the plugin's own files must be kept for the Orb (and exported
 * again): a binary that names a file in the plugin needs it there.
 */
export const codeNeedsPluginFiles = (code: ReadPluginCode | undefined) =>
  // ─── The Orb host runs the plugin's files ───
  code?.hosts?.orb !== undefined ||
  (code?.binaries ?? []).some(
    ({ url, path }) => url === undefined && path !== undefined,
  );

export const readDxExtension = Effect.fn("readDxExtension")(function* (
  folder: BundleFolder,
  block: unknown,
  /** The plugin's own name, which `permissions.plugins` may not list. */
  pluginName = "",
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
  // A block with only an icon dresses a plugin that has no code.
  if (Object.keys(block).every((field) => field === "icon")) return undefined;
  const skipField = (path: string, reason: string) => folder.skip(path, reason);
  skipUnknownFields(skipField, block, [...blockFields], label);
  if (block.apiVersion !== 1)
    return off("apiVersion must be 1, the plugin API version dx supports.");
  // ─── Hosts ───
  // `host` is "worker" or an object of entry modules per host; the object
  // form is normalized into `entry` (the Worker's module) plus `hosts`.
  const checkEntry = (field: string, value: unknown) => {
    if (typeof value !== "string")
      return { error: `${field} must name an entry module.` } as const;
    const path = manifestPath(value);
    if (path === "outside" || path === "")
      return { error: `${field} must be a file inside the plugin.` } as const;
    if (!path.startsWith(`${CODE_FOLDER}/`))
      return {
        error: `${field} must be inside the ${CODE_FOLDER}/ folder.`,
      } as const;
    if (/\.(?:ts|mts|tsx)$/.test(path))
      return {
        error: `dx runs JavaScript. Build the TypeScript ${field} to a .js module and point ${field} at it.`,
      } as const;
    if (!isModule(path))
      return { error: `${field} must be a .js or .mjs module.` } as const;
    if (!folder.files.has(path))
      return { error: `${path} is missing.` } as const;
    return { path } as const;
  };
  const rawHost = block.host ?? "worker";
  let entry: string;
  let hosts: PluginCodeHosts | undefined;
  if (typeof rawHost === "string") {
    if (rawHost !== "worker")
      return off(
        `host must be worker, or an object naming an entry module per host: ${PLUGIN_HOST_KINDS.join(", ")}.`,
      );
    if (typeof block.entry !== "string")
      return off("entry must name the code's entry module.");
    const checked = checkEntry("entry", block.entry);
    if ("error" in checked) return off(checked.error ?? "");
    entry = checked.path;
  } else {
    if (!isRecord(rawHost))
      return off(
        `host must be worker, or an object naming an entry module per host: ${PLUGIN_HOST_KINDS.join(", ")}.`,
      );
    const unknownHosts = Object.keys(rawHost).filter(
      (kind) => !(PLUGIN_HOST_KINDS as ReadonlyArray<string>).includes(kind),
    );
    if (unknownHosts.length > 0)
      return off(
        `dx has no host named ${unknownHosts.join(", ")}. Hosts: ${PLUGIN_HOST_KINDS.join(", ")}.`,
      );
    if (
      block.entry !== undefined &&
      rawHost.worker !== undefined &&
      block.entry !== rawHost.worker
    )
      return off(
        "entry and host.worker name different modules; name the Worker's module once.",
      );
    const paths: Partial<Record<PluginHostKind, string>> = {};
    // `worker` defaults to `entry`.
    const named = {
      ...(block.entry === undefined ? {} : { worker: block.entry }),
      ...rawHost,
    } as Record<string, unknown>;
    for (const kind of PLUGIN_HOST_KINDS) {
      if (named[kind] === undefined) continue;
      const checked = checkEntry(`host.${kind}`, named[kind]);
      if ("error" in checked) return off(checked.error ?? "");
      paths[kind] = checked.path;
    }
    const first = PLUGIN_HOST_KINDS.map((kind) => paths[kind]).find(
      (path) => path !== undefined,
    );
    if (first === undefined)
      return off("host names no entry module for any host.");
    entry = paths.worker ?? first;
    hosts = paths;
  }

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
  // The plugins ctx.plugins.call may reach.
  const callTargets = readDxCallTargets(rawPermissions.plugins, pluginName);
  if (!callTargets.ok) return off(callTargets.reason);
  if (
    rawPermissions.wake !== undefined &&
    typeof rawPermissions.wake !== "boolean"
  )
    return off("permissions.wake must be true or false.");
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
    ...(callTargets.value === undefined ? {} : { plugins: callTargets.value }),
    ...(rawPermissions.wake === true ? { wake: true } : {}),
  });
  if (Option.isNone(permissions))
    return off(
      "A permission is malformed: network lists host names, secrets and tools list names.",
    );

  const rawSettings = block.settings ?? [];
  if (!Array.isArray(rawSettings)) return off("settings must be a list.");
  const settings: Array<PluginCodeSetting> = [];
  for (const [index, raw] of rawSettings.entries()) {
    skipUnknownFields(
      skipField,
      raw,
      Object.keys(PluginCodeSetting.fields),
      `${label}.settings[${index}]`,
    );
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
  for (const [index, raw] of rawModes.entries()) {
    skipUnknownFields(
      skipField,
      raw,
      Object.keys(PluginAgentMode.fields),
      `${label}.agentModes[${index}]`,
    );
    const mode = Schema.decodeUnknownOption(PluginAgentMode)(raw);
    if (Option.isNone(mode))
      return off(
        "Each agent mode needs a key (1 to 24 lowercase letters, digits, and hyphens), a label of at most 24 characters, and optionally a description and a #rrggbb color.",
      );
    if (agentModes.some(({ key }) => key === mode.value.key))
      return off(`Two agent modes share the key ${mode.value.key}.`);
    agentModes.push(mode.value);
  }
  // ─── The Orb host ───
  // An Orb process runs with the Thread's files, environment, and secrets,
  // as its commands do, so it is reviewed as one: it needs shell.
  if (hosts?.orb !== undefined && permissions.value.shell !== true)
    return off(
      "host.orb runs in each Thread's Orb with its files, environment, and secrets, so it needs permissions.shell set to true.",
    );
  if (agentModes.length > 0 && permissions.value.agents !== true)
    return off("agentModes needs permissions.agents set to true.");

  // A ceiling, so a value dx can't read fails closed to the
  // lowest tier rather than lifting the ceiling.
  const tier =
    block.tier === undefined
      ? undefined
      : Schema.is(PluginTier)(block.tier)
        ? block.tier
        : "sandboxed";
  if (block.tier !== undefined && block.tier !== tier)
    folder.skip(
      `${label}.tier`,
      "tier must be sandboxed, personal-dev, workspace-trusted, or verified; dx reads it as sandboxed.",
    );
  // ─── Binaries ───
  // Host-neutral checks only; each host applies its own rules when it runs.
  const rawBinaries = block.binaries ?? [];
  if (!Array.isArray(rawBinaries)) return off("binaries must be a list.");
  if (rawBinaries.length > MAX_PLUGIN_BINARIES)
    return off(`A plugin declares at most ${MAX_PLUGIN_BINARIES} binaries.`);
  const binaries: Array<PluginCodeBinary> = [];
  for (const [index, raw] of rawBinaries.entries()) {
    skipUnknownFields(
      skipField,
      raw,
      Object.keys(PluginCodeBinary.fields),
      `${label}.binaries[${index}]`,
    );
    const decoded = Schema.decodeUnknownOption(PluginCodeBinary)(raw);
    if (Option.isNone(decoded))
      return off(
        "Each binary needs a name (a file name of letters, digits, dots, hyphens, underscores, or pluses) and one of apt (a Debian package name), url (https, with a sha256 of 64 lowercase hex digits), or path (a file in the plugin).",
      );
    const binary = decoded.value;
    const binaryLabel = `binaries ${binary.name}`;
    if (binaries.some(({ name }) => name === binary.name))
      return off(`Two binaries are named ${binary.name}.`);
    if (
      binary.apt === undefined &&
      binary.url === undefined &&
      binary.path === undefined
    )
      return off(`${binaryLabel} needs apt, url, or path.`);
    if (
      binary.apt !== undefined &&
      (binary.url !== undefined || binary.path !== undefined)
    )
      return off(`${binaryLabel} names an apt package and a file; choose one.`);
    if (binary.url !== undefined && !URL.canParse(binary.url))
      return off(`${binaryLabel}: url is not a valid https URL.`);
    if (binary.url !== undefined && binary.sha256 === undefined)
      return off(
        `${binaryLabel} downloads a url, so it needs the file\u2019s sha256.`,
      );
    if (
      binary.url === undefined &&
      binary.sha256 !== undefined &&
      binary.path === undefined
    )
      return off(
        `${binaryLabel} has a sha256 but no url or path to check it against.`,
      );
    let stored =
      binary.url === undefined
        ? binary
        : { ...binary, url: new URL(binary.url).href };
    if (binary.path !== undefined) {
      const path = manifestPath(binary.path);
      if (path === "outside" || path === "")
        return off(
          `${binaryLabel}: path must stay inside the ${binary.url === undefined ? "plugin" : "download"}.`,
        );
      if (binary.url === undefined && !folder.files.has(path))
        return off(`${binaryLabel}: ${path} is missing.`);
      stored = { ...stored, path };
    }
    binaries.push(stored);
  }
  // A Lucide name dx doesn't have would draw nothing: skip it, for panes
  // and views alike.
  const knownIcon = Effect.fn("knownIcon")(function* (
    icon: string | undefined,
    path: string,
  ) {
    if (icon?.startsWith("lucide:") !== true) return icon;
    const name = icon.slice("lucide:".length);
    if (yield* Effect.promise(() => lucideIconExists(name))) return icon;
    folder.skip(path, `dx has no Lucide icon named ${name}.`);
    return undefined;
  });
  const withKnownIcon = Effect.fn("withKnownIcon")(function* <
    T extends { readonly icon?: string },
  >(item: T, path: string) {
    if (item.icon === undefined) return item;
    const icon = yield* knownIcon(item.icon, `${label}.${path}`);
    if (icon !== undefined) return item;
    const { icon: _dropped, ...rest } = item;
    return rest as T;
  });
  if (
    block.archivedThreads !== undefined &&
    !isArchivedMode(block.archivedThreads)
  )
    return off(`archivedThreads must be ${PLUGIN_ARCHIVED_MODES.join(", ")}.`);
  const archivedThreads = block.archivedThreads as
    | PluginArchivedMode
    | undefined;
  const iconAssets = yield* readItemIconAssets(folder);
  const rawPanes = block.panes ?? [];
  if (!Array.isArray(rawPanes)) return off("panes must be a list.");
  if (rawPanes.length > MAX_PLUGIN_MANIFEST_PANES)
    return off(`A plugin declares at most ${MAX_PLUGIN_MANIFEST_PANES} panes.`);
  const panes: Array<PluginManifestPane> = [];
  for (const [index, raw] of rawPanes.entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(raw.id) ||
      typeof raw.title !== "string" ||
      raw.title.trim() === "" ||
      raw.title.trim().length > 40
    )
      return off(
        "Each pane needs an id (lowercase letters, digits, and hyphens, starting with a letter) and a title of at most 40 characters.",
      );
    if (panes.some(({ id }) => id === raw.id))
      return off(`Two panes share the id ${raw.id}.`);
    skipUnknownFields(skipField, raw, paneFields, `${label}.panes[${index}]`);
    skipUnknownFields(
      skipField,
      raw.connect,
      paneConnectFields,
      `${label}.panes[${index}].connect`,
    );
    if (
      raw.archivedThreads !== undefined &&
      !isArchivedMode(raw.archivedThreads)
    )
      return off(
        `panes[${index}].archivedThreads must be ${PLUGIN_ARCHIVED_MODES.join(", ")}.`,
      );
    const icon = yield* knownIcon(
      readItemIcon(
        folder,
        raw.icon,
        `${label}.panes[${index}].icon`,
        iconAssets.byPath,
      ),
      `${label}.panes[${index}].icon`,
    );
    panes.push({
      id: raw.id,
      title: raw.title.trim(),
      ...(icon === undefined ? {} : { icon }),
      ...(raw.archivedThreads === undefined
        ? {}
        : { archivedThreads: raw.archivedThreads as PluginArchivedMode }),
    });
  }
  // Views and exports, which the code registers with dx.registerView and
  // dx.expose.
  const viewsRead = readDxViews(
    block.views,
    (raw, path) =>
      readItemIcon(folder, raw, `${label}.${path}`, iconAssets.byPath),
    (path, reason) => folder.skip(`${label}.${path}`, reason),
    panes.map(({ id }) => id),
  );
  if (!viewsRead.ok) return off(viewsRead.reason);
  const views =
    viewsRead.value === undefined
      ? undefined
      : {
          tabs: yield* Effect.forEach(viewsRead.value.tabs, (tab, index) =>
            withKnownIcon(tab, `views.tabs[${index}].icon`),
          ),
          pages: yield* Effect.forEach(viewsRead.value.pages, (page, index) =>
            withKnownIcon(page, `views.pages[${index}].icon`),
          ),
          threadTypes: yield* Effect.forEach(
            viewsRead.value.threadTypes,
            (type, index) =>
              withKnownIcon(type, `views.threadTypes[${index}].icon`),
          ),
        };
  const exported = readDxExports(block.exports, (path, reason) =>
    folder.skip(`${label}.${path}`, reason),
  );
  if (!exported.ok) return off(exported.reason);
  // What each pane's view may reach.
  const paneConnect = readPaneConnect(
    block.panes,
    permissions.value.network,
    (field, reason) => folder.skip(`${label}.${field}`, reason),
  );

  // Jobs and the durable scope are read for every tier; whether they run is
  // decided when the install's tier is resolved.
  const durableScope = block.durableScope;
  if (
    durableScope !== undefined &&
    !(PLUGIN_DURABLE_SCOPES as ReadonlyArray<unknown>).includes(durableScope)
  )
    return off(`durableScope must be ${PLUGIN_DURABLE_SCOPES.join(" or ")}.`);
  const rawJobs = block.jobs ?? [];
  if (!Array.isArray(rawJobs)) return off("jobs must be a list.");
  if (rawJobs.length > MAX_PLUGIN_JOBS)
    return off(`A plugin declares at most ${MAX_PLUGIN_JOBS} jobs.`);
  const jobs: Array<PluginJob> = [];
  for (const [index, raw] of rawJobs.entries()) {
    skipUnknownFields(
      skipField,
      raw,
      Object.keys(PluginJob.fields),
      `${label}.jobs[${index}]`,
    );
    if (isRecord(raw))
      skipUnknownFields(
        skipField,
        raw.schedule,
        jobScheduleFields,
        `${label}.jobs[${index}].schedule`,
      );
    const job = Schema.decodeUnknownOption(PluginJob)(raw);
    if (Option.isNone(job))
      return off(
        'Each job needs an id (1 to 48 lowercase letters, digits, and hyphens), a title of at most 80 characters, and a schedule: { "every": "5m" } (1m to 30d), { "cron": "0 * * * *" } (five fields, UTC), or { "at": "on-demand" }.',
      );
    if (jobs.some(({ id }) => id === job.value.id))
      return off(`Two jobs share the id ${job.value.id}.`);
    const schedule = job.value.schedule;
    if ("every" in schedule && everyMs(schedule.every) === undefined)
      return off(
        `The job ${job.value.id}'s every is ${schedule.every}; use 1m to 30d, such as 5m, 2h, or 1d.`,
      );
    if ("cron" in schedule && parseCron(schedule.cron) === undefined)
      return off(
        `The job ${job.value.id}'s cron is not five fields (minute hour day month weekday, UTC) dx can read.`,
      );
    jobs.push(job.value);
  }

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
    ...(hosts === undefined ? {} : { hosts }),
    permissions: permissions.value,
    settings,
    ...(agentModes.length === 0 ? {} : { agentModes }),
    ...(tier === undefined ? {} : { tier }),
    ...(binaries.length === 0 ? {} : { binaries }),
    ...(views === undefined ? {} : { views }),
    ...(exported.value === undefined ? {} : { exports: exported.value }),
    ...(durableScope === undefined
      ? {}
      : { durableScope: durableScope as PluginDurableScope }),
    ...(jobs.length === 0 ? {} : { jobs }),
    ...(paneConnect.length === 0 ? {} : { paneConnect }),
    modules,
    ...(archivedThreads === undefined ? {} : { archivedThreads }),
    ...(panes.length === 0 ? {} : { panes }),
    ...(iconAssets.files.length === 0
      ? {}
      : { iconAssets: iconAssets.byPath, iconFiles: iconAssets.files }),
  } satisfies ReadPluginCode;
});
