import { Schema } from "effect";

/**
 * Where a plugin's code runs. `worker` is the Dynamic Worker every plugin
 * has; `durable` is a long-lived Durable Object per install (or per install
 * and Thread); `orb` is a dxd-supervised process in the Thread's Orb;
 * `container` is a Cloudflare Container per install. Every kind but `worker`
 * needs a trusted tier.
 */
export const PLUGIN_HOST_KINDS = [
  "worker",
  "durable",
  "orb",
  "container",
] as const;

export const PluginHostKind = Schema.Literals(PLUGIN_HOST_KINDS);

export type PluginHostKind = (typeof PLUGIN_HOST_KINDS)[number];

/** Entry module paths per host, from the manifest's object form of `host`. */
export const PluginCodeHosts = Schema.Struct({
  worker: Schema.optional(Schema.String),
  durable: Schema.optional(Schema.String),
  orb: Schema.optional(Schema.String),
  container: Schema.optional(Schema.String),
});

export type PluginCodeHosts = typeof PluginCodeHosts.Type;

/**
 * The entry module each host runs. `hosts.worker`, when absent, means
 * `entry`, so every plugin with code has Worker code: a module written only
 * for another host loads there too and simply registers nothing it runs.
 * Declared `jobs` run in the durable host, from `hosts.durable` or, when
 * the manifest names none, from the Worker's module.
 */
export const pluginHostEntry = (
  code: PluginHostCode,
  kind: PluginHostKind,
): string | undefined =>
  kind === "worker"
    ? (code.hosts?.worker ?? code.entry)
    : kind === "durable"
      ? (code.hosts?.durable ??
        ((code.jobs?.length ?? 0) > 0
          ? (code.hosts?.worker ?? code.entry)
          : undefined))
      : code.hosts?.[kind];

interface PluginHostCode {
  readonly entry: string;
  readonly hosts?: PluginCodeHosts | undefined;
  readonly jobs?: ReadonlyArray<unknown> | undefined;
}

/** The hosts a plugin's code runs in, in {@link PLUGIN_HOST_KINDS} order. */
export const pluginHostKinds = (
  code: PluginHostCode,
): ReadonlyArray<PluginHostKind> =>
  PLUGIN_HOST_KINDS.filter((kind) => pluginHostEntry(code, kind) !== undefined);
