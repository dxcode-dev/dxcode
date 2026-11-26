import {
  MAX_PLUGIN_AGENT_MODES,
  MAX_PLUGIN_BINARIES,
  MAX_PLUGIN_CODE_MODELS,
  MAX_PLUGIN_CODE_MODULE_BYTES,
  MAX_PLUGIN_CODE_MODULES,
  MAX_PLUGIN_CODE_TOTAL_BYTES,
  MAX_PLUGIN_SERVICE_LISTENERS,
  MAX_PLUGIN_SERVICE_SCHEDULES,
  MAX_PLUGIN_SERVICE_TOOLS,
  PLUGIN_ARCHIVED_MODES,
  PLUGIN_CODE_EVENTS,
  PLUGIN_CODE_THREAD_GRANTS,
  PLUGIN_CODE_UI_GRANTS,
  PLUGIN_HOST_KINDS,
  PLUGIN_SERVICE_APP_PATH,
  PluginAgentMode,
  type PluginArchivedMode,
  PluginCodeBinary,
  type PluginCodeHosts,
  PluginCodeModel,
  PluginCodePermissions,
  PluginCodeSetting,
  type PluginDataViewEntry,
  type PluginExport,
  type PluginHostKind,
  PluginService,
  PluginServiceListener,
  PluginServiceSchedule,
  pluginRebuildMessage,
  RETIRED_PLUGIN_UI_GRANT,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { lucideIconExists } from "../../../plugins/icons/lucide.js";
import { everyMs, parseCron } from "../../../plugins/services/schedule-spec.js";
import {
  type BundleFolder,
  isRecord,
  manifestPath,
  skipUnknownFields,
} from "./bundle-reader.js";
import { readDxDataViews } from "./dx-data-views.js";
import { readDxCallTargets, readDxExports } from "./dx-views.js";
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
  "binaries",
  "icon",
  "archivedThreads",
  // Retired: `skipRetired` says what to use instead.
  "panes",
  "views",
  "exports",
  "service",
  "schedules",
  "listeners",
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
  "plugins",
]);

const isModule = (path: string) => /\.m?js$/.test(path);
const isTypeScript = (path: string) => /\.(?:ts|mts)$/.test(path);

/** What an author uses instead of plugin panes and code-drawn views. */
const USE_A_VIEW =
  "Describe the screen as a view: list it in views with a JSON file (see examples/plugins/log-watch).";

/**
 * Plugin panes, their `connect`, the `pane` UI grant, and the object form
 * of `views` (tabs, pages, and Thread types drawn by code) were removed on
 * 2026-11-25. Each is skipped, with what to use instead; the rest of the
 * plugin loads.
 */
const skipRetired = (
  block: Record<string, unknown>,
  label: string,
  skip: (path: string, reason: string) => void,
) => {
  if (block.panes !== undefined)
    skip(`${label}.panes`, `Plugin panes were removed. ${USE_A_VIEW}`);
  if (Array.isArray(block.panes))
    for (const [index, pane] of block.panes.entries())
      if (isRecord(pane) && pane.connect !== undefined)
        skip(
          `${label}.panes[${index}].connect`,
          `A pane's hosts, Portal ports, and WebRTC were removed with plugin panes. ${USE_A_VIEW}`,
        );
  if (isRecord(block.views))
    skip(
      `${label}.views`,
      'Views drawn by plugin code (tabs, pages, and Thread types) were removed. List each view in views as a list entry with a JSON file and where it shows, such as show: ["page"]; a view with show: ["app"] is a Thread type (see examples/plugins/log-watch).',
    );
  const permissions = block.permissions;
  if (
    isRecord(permissions) &&
    Array.isArray(permissions.ui) &&
    permissions.ui.includes(RETIRED_PLUGIN_UI_GRANT)
  )
    skip(
      `${label}.permissions.ui`,
      `The pane UI permission was removed with plugin panes; views need no permission. ${USE_A_VIEW}`,
    );
};

export interface PluginCodeModule {
  readonly path: string;
  readonly content: string;
}

export interface ReadPluginCode {
  readonly apiVersion: 1;
  readonly host: "worker";
  /** Absent for a plugin whose only code is its service. */
  readonly entry?: string;
  /** A program on a plugin Orb, with its schedules and listeners. */
  readonly service?: PluginService;
  readonly schedules?: ReadonlyArray<PluginServiceSchedule>;
  readonly listeners?: ReadonlyArray<PluginServiceListener>;
  /** Entry modules per host, when the manifest used the object form. */
  readonly hosts?: PluginCodeHosts;
  readonly permissions: PluginCodePermissions;
  readonly settings: ReadonlyArray<PluginCodeSetting>;
  readonly agentModes?: ReadonlyArray<PluginAgentMode>;
  /** Native tools for the Orb host. */
  readonly binaries?: ReadonlyArray<PluginCodeBinary>;
  /** Views described as data, from the array form of `views`. */
  readonly dataViews?: ReadonlyArray<PluginDataViewEntry>;
  /** Their files, stored with the version's files (not loaded as code). */
  readonly viewFiles?: ReadonlyArray<PluginCodeModule>;
  /** Functions other plugins may call. */
  readonly exports?: ReadonlyArray<PluginExport>;
  /** Every JavaScript module under `dev.dxcode/`, entry first. */
  readonly modules: ReadonlyArray<PluginCodeModule>;
  readonly archivedThreads?: PluginArchivedMode;
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
  // ─── The Orb host and a service run the plugin's files ───
  code?.hosts?.orb !== undefined ||
  code?.service !== undefined ||
  (code?.binaries ?? []).some(
    ({ url, path }) => url === undefined && path !== undefined,
  );

export const readDxExtension = Effect.fn("readDxExtension")(function* (
  folder: BundleFolder,
  block: unknown,
  /** The plugin's own name, which `permissions.plugins` may not list. */
  pluginName = "",
  /**
   * A draft (`dxd plugin load`) runs all of its code from its folder in
   * the Thread's Orb under Node: any entry may be TypeScript, and no module
   * is read or kept.
   */
  options: { readonly draft?: boolean } = {},
) {
  const draft = options.draft === true;
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
  // Features dx removed: the plugin must be rebuilt, not run half.
  const rebuild = pluginRebuildMessage({
    ...block,
    hosts: isRecord(block.host) ? block.host : undefined,
  });
  if (rebuild !== undefined) return off(rebuild);
  const skipField = (path: string, reason: string) => folder.skip(path, reason);
  skipUnknownFields(skipField, block, [...blockFields], label);
  skipRetired(block, label, skipField);
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
    // Code that runs in an Orb runs under Node, which loads TypeScript;
    // a function inside dx runs JavaScript only.
    const typeScript = isTypeScript(path);
    if (typeScript && !draft && field !== "host.orb")
      return {
        error: `dx runs JavaScript for ${field}, a function inside dx. Build the TypeScript to a .js module and point ${field} at it, or run the code in the Thread's Orb as host.orb, which may be TypeScript.`,
      } as const;
    if (/\.tsx$/.test(path))
      return {
        error: `${field} is a .tsx file; use .ts, .mts, .js, or .mjs.`,
      } as const;
    if (!isModule(path) && !typeScript)
      return {
        error: `${field} must be a .js or .mjs module${draft ? ", or .ts or .mts" : ""}.`,
      } as const;
    if (!folder.files.has(path))
      return { error: `${path} is missing.` } as const;
    return { path } as const;
  };
  // ─── Service ───
  // A service is a program in any language; with one, the Worker entry is
  // optional and a plugin may have no JavaScript for dx to run.
  const service = readService(block, label, skipField);
  if (service !== undefined && !service.ok) return off(service.reason);
  const serviceOnly =
    service?.value.service !== undefined &&
    block.entry === undefined &&
    block.host === undefined;
  const rawHost = block.host ?? "worker";
  let entry: string | undefined;
  let hosts: PluginCodeHosts | undefined;
  if (serviceOnly) {
    entry = undefined;
  } else if (typeof rawHost === "string") {
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
    if (!draft && isTypeScript(entry))
      return off(
        `The function that registers ${pluginName || "the plugin"}'s tools runs inside dx and must be JavaScript. Add a JavaScript host.worker entry; Orb code (host.orb) may stay TypeScript.`,
      );
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
  // The retired `pane` grant is skipped (skipRetired says why), not refused.
  const ui = stringList(rawPermissions.ui)?.filter(
    (grant) => grant !== RETIRED_PLUGIN_UI_GRANT,
  );
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
  // A schedule without a service, and a URL listener, are events for the
  // function code: declaring them grants the event.
  const implied = [
    ...(service?.ok === true &&
    service.value.service === undefined &&
    (service.value.schedules?.length ?? 0) > 0
      ? ["job.run"]
      : []),
    ...(service?.ok === true &&
    (service.value.listeners ?? []).some((listener) => "url" in listener)
      ? ["listener.event"]
      : []),
  ];
  const permissions = Schema.decodeUnknownOption(PluginCodePermissions)({
    events: [...new Set([...events, ...implied])],
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
  });
  if (Option.isNone(permissions))
    return off(
      "A permission is malformed: network lists host names, secrets and tools list names.",
    );

  // Events, `tool.call` gates among them, run in function code or the
  // Thread's Orb; a service may sleep, so it never answers one.
  if (serviceOnly && permissions.value.events.length > 0)
    return off(
      `A program on a plugin Orb does not handle events (${permissions.value.events.join(", ")}): its Orb may be asleep when one fires. Handle them in function code (entry) and call the program from there.`,
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

  // ─── Schedules and listeners for the function code ───
  if (service?.ok === true) {
    const functionSchedules =
      service.value.service === undefined &&
      (service.value.schedules?.length ?? 0) > 0;
    if (functionSchedules && entry === undefined)
      return off("schedules without a service run the code's entry module.");
    for (const listener of service.value.listeners ?? []) {
      if (!("url" in listener)) continue;
      if (entry === undefined)
        return off(
          `The listener ${listener.name} watches a URL for the code's entry module; name one.`,
        );
      const host = new URL(listener.url).hostname.toLowerCase();
      if (!hostGranted(permissions.value.network, host))
        return off(
          `The listener ${listener.name} watches ${host}, which permissions.network does not list.`,
        );
    }
  }
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
  // A Lucide name dx doesn't have would draw nothing: skip it.
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
  // Views described as data: the list form of `views` (dx-data-views.ts).
  const dataViewsRead = Array.isArray(block.views)
    ? yield* readDxDataViews(folder, block.views, label, (raw, path) =>
        readItemIcon(folder, raw, `${label}.${path}`, iconAssets.byPath),
      )
    : undefined;
  const dataViews =
    dataViewsRead === undefined
      ? []
      : yield* Effect.forEach(dataViewsRead.entries, (entry, index) =>
          withKnownIcon(entry, `views[${index}].icon`),
        );
  const exported = readDxExports(block.exports, (path, reason) =>
    folder.skip(`${label}.${path}`, reason),
  );
  if (!exported.ok) return off(exported.reason);

  // A draft's code runs from its folder: nothing is read or kept here.
  if (draft && binaries.length > 0)
    folder.skip(
      `${label}.binaries`,
      "A draft runs with what this Orb already has; install these here yourself. dx installs them when the plugin is kept.",
    );
  const draftEntry = entry;
  if (draft && draftEntry === undefined)
    return off(
      "A draft runs its entry module in this Thread's Orb, and this plugin has none. A draft's service does not run yet: keep the plugin to run its service.",
    );
  if (draft && draftEntry !== undefined)
    return {
      apiVersion: 1,
      host: "worker",
      entry,
      ...(hosts === undefined ? {} : { hosts }),
      permissions: permissions.value,
      settings,
      ...(agentModes.length === 0 ? {} : { agentModes }),
      ...(exported.value === undefined ? {} : { exports: exported.value }),
      // A draft's views draw in its Thread's panel; their files stay with
      // the draft in the Thread's own object.
      ...(dataViews.length === 0
        ? {}
        : { dataViews, viewFiles: dataViewsRead?.files ?? [] }),
      modules: [{ path: draftEntry, content: "" }],
      ...(archivedThreads === undefined ? {} : { archivedThreads }),
      ...(iconAssets.files.length === 0
        ? {}
        : { iconAssets: iconAssets.byPath, iconFiles: iconAssets.files }),
    } satisfies ReadPluginCode;
  // Modules: every JavaScript file under dev.dxcode/, so relative imports
  // resolve; other files there (views) are for later milestones.
  const modulePaths = [
    ...(entry === undefined ? [] : [entry]),
    ...folder
      .under(CODE_FOLDER)
      .filter((path) => path !== entry && isModule(path))
      .sort(),
  ];
  for (const path of folder.under(CODE_FOLDER))
    if (
      !isModule(path) &&
      !(isTypeScript(path) && hosts?.orb !== undefined) &&
      !dataViews.some(({ file }) => file === path)
    )
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
    ...(entry === undefined ? {} : { entry }),
    ...(hosts === undefined ? {} : { hosts }),
    ...(service === undefined ? {} : service.value),
    permissions: permissions.value,
    settings,
    ...(agentModes.length === 0 ? {} : { agentModes }),
    ...(binaries.length === 0 ? {} : { binaries }),
    ...(dataViews.length === 0
      ? {}
      : { dataViews, viewFiles: dataViewsRead?.files ?? [] }),
    ...(exported.value === undefined ? {} : { exports: exported.value }),
    modules,
    ...(archivedThreads === undefined ? {} : { archivedThreads }),
    ...(iconAssets.files.length === 0
      ? {}
      : { iconAssets: iconAssets.byPath, iconFiles: iconAssets.files }),
  } satisfies ReadPluginCode;
});

const serviceFields = [
  "run",
  "setup",
  "orb",
  "keepRunning",
  "tools",
  "app",
  "http",
];
const serviceToolFields = ["name", "description", "input"];
const scheduleFields = ["name", "every", "cron"];
const listenerFields = ["name", "run", "url"];

/** Whether `host` is one `network` lists: exactly, or under a `*.` entry. */
const hostGranted = (network: ReadonlyArray<string>, host: string) =>
  network.some((granted) =>
    granted.startsWith("*.")
      ? host.endsWith(granted.slice(1)) && host.length > granted.length - 1
      : granted === host,
  );

/**
 * `service`, `schedules`, and `listeners` from the block, or undefined when
 * it declares none. Schedules go to the service when there is one, else to
 * the function code; a listener with `run` needs the service, one with `url`
 * the function code.
 */
const readService = (
  block: Record<string, unknown>,
  label: string,
  skipField: (path: string, reason: string) => void,
):
  | undefined
  | { readonly ok: false; readonly reason: string }
  | {
      readonly ok: true;
      readonly value: {
        readonly service?: PluginService;
        readonly schedules?: ReadonlyArray<PluginServiceSchedule>;
        readonly listeners?: ReadonlyArray<PluginServiceListener>;
      };
    } => {
  const failed = (reason: string) => ({ ok: false, reason }) as const;
  if (
    block.service === undefined &&
    block.schedules === undefined &&
    block.listeners === undefined
  )
    return undefined;
  const service =
    block.service === undefined
      ? undefined
      : readServiceProgram(block, label, skipField);
  if (service !== undefined && !service.ok) return service;
  const rawSchedules = block.schedules ?? [];
  if (!Array.isArray(rawSchedules)) return failed("schedules must be a list.");
  if (rawSchedules.length > MAX_PLUGIN_SERVICE_SCHEDULES)
    return failed(
      `A plugin declares at most ${MAX_PLUGIN_SERVICE_SCHEDULES} schedules.`,
    );
  const schedules: Array<PluginServiceSchedule> = [];
  for (const [index, raw] of rawSchedules.entries()) {
    skipUnknownFields(
      skipField,
      raw,
      scheduleFields,
      `${label}.schedules[${index}]`,
    );
    const schedule = Schema.decodeUnknownOption(PluginServiceSchedule)(raw);
    if (Option.isNone(schedule))
      return failed(
        'Each schedule needs a name (1 to 48 lowercase letters, digits, and hyphens) and either every ("15m", 1m to 30d) or cron ("0 * * * *", five fields, UTC).',
      );
    const value = schedule.value;
    if (schedules.some(({ name }) => name === value.name))
      return failed(`Two schedules share the name ${value.name}.`);
    if ("every" in value && everyMs(value.every) === undefined)
      return failed(
        `The schedule ${value.name}'s every is ${value.every}; use 1m to 30d, such as 15m, 2h, or 1d.`,
      );
    if ("cron" in value && parseCron(value.cron) === undefined)
      return failed(
        `The schedule ${value.name}'s cron is not five fields (minute hour day month weekday, UTC) dx can read.`,
      );
    schedules.push(value);
  }
  const rawListeners = block.listeners ?? [];
  if (!Array.isArray(rawListeners)) return failed("listeners must be a list.");
  if (rawListeners.length > MAX_PLUGIN_SERVICE_LISTENERS)
    return failed(
      `A plugin declares at most ${MAX_PLUGIN_SERVICE_LISTENERS} listeners.`,
    );
  const listeners: Array<PluginServiceListener> = [];
  for (const [index, raw] of rawListeners.entries()) {
    skipUnknownFields(
      skipField,
      raw,
      listenerFields,
      `${label}.listeners[${index}]`,
    );
    const listener = Schema.decodeUnknownOption(PluginServiceListener)(raw);
    if (Option.isNone(listener))
      return failed(
        'Each listener needs a name (1 to 48 lowercase letters, digits, and hyphens) and either run, a command such as "tail -F app.log", or url, a wss:// or https:// address.',
      );
    if ("run" in listener.value && service === undefined)
      return failed(
        `The listener ${listener.value.name} runs a command on the plugin's service; declare a service, or watch a url instead.`,
      );
    if (listeners.some(({ name }) => name === listener.value.name))
      return failed(`Two listeners share the name ${listener.value.name}.`);
    listeners.push(listener.value);
  }
  return {
    ok: true,
    value: {
      ...(service === undefined ? {} : { service: service.value }),
      ...(schedules.length === 0 ? {} : { schedules }),
      ...(listeners.length === 0 ? {} : { listeners }),
    },
  };
};

/** The `service` object: its program, setup, Orb, and tools. */
const readServiceProgram = (
  block: Record<string, unknown>,
  label: string,
  skipField: (path: string, reason: string) => void,
):
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly value: PluginService } => {
  const failed = (reason: string) => ({ ok: false, reason }) as const;
  if (!isRecord(block.service))
    return failed(
      'service must be an object such as { "run": "node service.js" }.',
    );
  skipUnknownFields(
    skipField,
    block.service,
    serviceFields,
    `${label}.service`,
  );
  const rawTools = block.service.tools ?? [];
  if (!Array.isArray(rawTools)) return failed("service.tools must be a list.");
  if (rawTools.length > MAX_PLUGIN_SERVICE_TOOLS)
    return failed(
      `A service answers at most ${MAX_PLUGIN_SERVICE_TOOLS} tools.`,
    );
  for (const [index, raw] of rawTools.entries())
    skipUnknownFields(
      skipField,
      raw,
      serviceToolFields,
      `${label}.service.tools[${index}]`,
    );
  const service = Schema.decodeUnknownOption(PluginService)({
    orb: "shared",
    keepRunning: false,
    ...block.service,
    ...(rawTools.length === 0 ? { tools: undefined } : {}),
  });
  if (Option.isNone(service))
    return failed(
      'service needs run, a command of at most 1,024 characters such as "node service.js"; setup is an optional command; orb is shared or own; keepRunning and http are true or false; each tool has a name (lowercase letters, digits, and _), a description, and an optional input JSON Schema.',
    );
  const appPath = service.value.app?.path;
  if (appPath !== undefined && !PLUGIN_SERVICE_APP_PATH.test(appPath))
    return failed(
      'service.app.path must be an absolute path of letters, digits, and . _ ~ - /, such as "/app/".',
    );
  const names = new Set<string>();
  for (const tool of service.value.tools ?? []) {
    if (names.has(tool.name))
      return failed(`Two service tools share the name ${tool.name}.`);
    names.add(tool.name);
  }
  return { ok: true, value: service.value };
};
