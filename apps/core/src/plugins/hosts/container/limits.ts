/**
 * Prices, instance size, and caps of the `container` plugin host.
 *
 * Cloudflare Containers list prices (Workers Paid, checked 2026-11-12 at
 * developers.cloudflare.com/containers/pricing), billed per 10 ms while the
 * container runs; memory and disk on the provisioned size, CPU on use:
 *
 * | Resource | Included per month | Over that          |
 * |----------|--------------------|--------------------|
 * | Memory   | 25 GiB-hours       | $0.0000025 / GiB-s |
 * | CPU      | 375 vCPU-minutes   | $0.000020 / vCPU-s |
 * | Disk     | 200 GB-hours       | $0.00000007 / GB-s |
 *
 * Egress is $0.025/GB in North America and Europe (1 TB included); plugin
 * containers have no internet, so they make none. dx charges the full list
 * price to the installer's workspace and ignores the account's included
 * allowance, so the estimate never runs low.
 *
 * `basic` is 1/4 vCPU, 1 GiB, 4 GB disk: at most about $0.028 an hour with
 * its CPU busy the whole time, $0.010 an hour idle. A plugin that transcodes
 * a short clip in 20 seconds costs about $0.0002.
 */

export const PLUGIN_CONTAINER_INSTANCE = "basic";
/**
 * Plugin containers one deployment runs at once, across every install: at
 * most about $1.40 an hour if all run. Wrangler takes no `max_instances` for
 * Durable Object containers, so a deployment-wide ledger hands out slots
 * (object.ts).
 */
export const PLUGIN_CONTAINER_MAX_RUNNING = 50;
export const PLUGIN_CONTAINER_VCPU = 0.25;
export const PLUGIN_CONTAINER_MEMORY_GIB = 1;
export const PLUGIN_CONTAINER_DISK_GB = 4;

/** Millionths of a dollar per second, at list price. */
const MEMORY_MICROUSD_PER_GIB_S = 2.5;
const CPU_MICROUSD_PER_VCPU_S = 20;
const DISK_MICROUSD_PER_GB_S = 0.07;

/**
 * The cost of `ms` of container time, CPU counted as busy throughout:
 * Cloudflare reports no CPU use per call, so dx charges the ceiling.
 */
export const pluginContainerCostMicroUsd = (ms: number) =>
  Math.ceil(
    (Math.max(0, ms) / 1_000) *
      (PLUGIN_CONTAINER_MEMORY_GIB * MEMORY_MICROUSD_PER_GIB_S +
        PLUGIN_CONTAINER_VCPU * CPU_MICROUSD_PER_VCPU_S +
        PLUGIN_CONTAINER_DISK_GB * DISK_MICROUSD_PER_GB_S),
  );

/** Caps every install's container runs under. */
export interface PluginContainerCaps {
  /** One call's wall time; the tier's `callMs`. */
  readonly callMs: number;
  /** Calls one install's container runs at once; more wait their turn. */
  readonly concurrentCalls: number;
  /**
   * Time one install's calls may run per UTC day: from the plugin's code
   * starting to its answer. A cold start, installing code, and the idle
   * minute before the container stops do not count here.
   */
  readonly dailyMs: number;
  /** The same, per UTC month. */
  readonly monthlyMs: number;
  /**
   * A backstop on all container time (cold starts and idle minutes
   * included), as a multiple of `dailyMs` and `monthlyMs`. It bounds the
   * bill when many short calls each keep a container up for its idle
   * minute: without it, a one-second call every 61 seconds would run about
   * 28 container-hours a day.
   */
  readonly containerTimeMultiple: number;
  /**
   * Container time all installs billed to one workspace may use per UTC
   * day, so many installs cannot add up past it. A person in no workspace
   * is their own ledger.
   */
  readonly workspaceDailyMs: number;
  /** The container stops after this long without a call. */
  readonly idleMs: number;
  /** Bytes a call's arguments or result may carry. */
  readonly payloadBytes: number;
  /** Bytes of one `binaries` download. */
  readonly binaryBytes: number;
}

/**
 * Defaults: an hour of calls a day and ten a month per install, with at most
 * three times that in container time: about $0.08 a day and $0.84 a month at
 * most. `callMs` and `binaryBytes` come from the tier's limits.
 */
export const PLUGIN_CONTAINER_CAPS: PluginContainerCaps = {
  callMs: 300_000,
  concurrentCalls: 2,
  dailyMs: 60 * 60_000,
  monthlyMs: 10 * 60 * 60_000,
  containerTimeMultiple: 3,
  workspaceDailyMs: 8 * 60 * 60_000,
  idleMs: 60_000,
  payloadBytes: 8 * 1024 * 1024,
  binaryBytes: 100 * 1024 * 1024,
};

/**
 * Packages baked into the plugin image (deploy/plugin-container/Dockerfile).
 * A `binaries` entry whose `apt` is one of these is present at once; any
 * other `apt` entry is not available in a container (it has no internet to
 * install from) and the call says so.
 */
export const PLUGIN_CONTAINER_APT: ReadonlySet<string> = new Set([
  "ffmpeg",
  "imagemagick",
  "poppler-utils",
  "qpdf",
  "libimage-exiftool-perl",
  "jq",
  "sqlite3",
  "zip",
  "unzip",
  "xz-utils",
  "git",
  "python3",
  "nodejs",
]);
