import { Schema } from "effect";

/**
 * Where a plugin's code runs: `worker` is the function code every plugin
 * with code has (a Dynamic Worker); `orb` is a dxd-supervised process in the
 * Thread's Orb. A plugin's schedules, URL listeners, and state need no host
 * of their own: dx runs them for the function code (wiki "Plugin code").
 */
export const PLUGIN_HOST_KINDS = ["worker", "orb"] as const;

export const PluginHostKind = Schema.Literals(PLUGIN_HOST_KINDS);

export type PluginHostKind = (typeof PLUGIN_HOST_KINDS)[number];

/** Entry module paths per host, from the manifest's object form of `host`. */
export const PluginCodeHosts = Schema.Struct({
  worker: Schema.optional(Schema.String),
  orb: Schema.optional(Schema.String),
});

export type PluginCodeHosts = typeof PluginCodeHosts.Type;

/**
 * The entry module each host runs. `hosts.worker`, when absent, means
 * `entry`, so every plugin with code has Worker code: a module written only
 * for another host loads there too and simply registers nothing it runs.
 */
export const pluginHostEntry = (
  code: PluginHostCode,
  kind: PluginHostKind,
): string | undefined =>
  kind === "worker" ? (code.hosts?.worker ?? code.entry) : code.hosts?.[kind];

interface PluginHostCode {
  /** Absent for a plugin whose only code is a service; it runs no host. */
  readonly entry?: string | undefined;
  readonly hosts?: PluginCodeHosts | undefined;
}

/** The hosts a plugin's code runs in, in {@link PLUGIN_HOST_KINDS} order. */
export const pluginHostKinds = (
  code: PluginHostCode,
): ReadonlyArray<PluginHostKind> =>
  PLUGIN_HOST_KINDS.filter((kind) => pluginHostEntry(code, kind) !== undefined);
