import { Schema } from "effect";

/** A schedule's or listener's name. */
export const PLUGIN_JOB_ID = /^[a-z][a-z0-9-]{0,47}$/;
export const PluginJobId = Schema.String.check(Schema.isPattern(PLUGIN_JOB_ID));

/**
 * A plugin's service (`extensions["dev.dxcode"].service`): a program in any
 * language that dxd starts on a plugin Orb, restarts when it exits, and logs.
 * dx calls it over HTTP for its tools, schedules, listener events, and view
 * calls, and it calls dx back through `DX_API`. The contract is in
 * tasks/plugins-next.md ("Service") and wiki/plugin-platform-direction.md
 * ("Plugin services").
 */

export const MAX_PLUGIN_SERVICE_TOOLS = 32;
export const MAX_PLUGIN_SERVICE_SCHEDULES = 16;
export const MAX_PLUGIN_SERVICE_LISTENERS = 8;
export const MAX_PLUGIN_SERVICE_COMMAND = 1_024;

/** A service page's path: absolute, URL-safe, at most 201 characters. */
export const PLUGIN_SERVICE_APP_PATH = /^\/[A-Za-z0-9._~\-/]{0,200}$/;

/**
 * A token the program issued for its `service.http` address is a state key
 * of this prefix followed by the SHA-256 (lowercase hex) of the token; its
 * value may name the one path it opens (`{ "path": "/mcp/grafana" }`).
 * Deleting the key revokes the token at the next request.
 */
export const PLUGIN_SERVICE_HTTP_TOKEN_PREFIX = "http-token:";

/** A shell command line dxd runs with `bash -lc` in the plugin's folder. */
export const PluginServiceCommand = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PLUGIN_SERVICE_COMMAND),
);

/** A tool the running service answers at `POST /tools/<name>`. */
export const PluginServiceTool = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/)),
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_024),
  ),
  /** JSON Schema of the tool's input; an object with no fields when absent. */
  input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

export type PluginServiceTool = typeof PluginServiceTool.Type;

/** `"shared"`: the scope's plugin Orb. `"own"`: a plugin Orb for this plugin. */
export const PLUGIN_SERVICE_ORBS = ["shared", "own"] as const;
export type PluginServiceOrb = (typeof PLUGIN_SERVICE_ORBS)[number];

export const PluginService = Schema.Struct({
  run: PluginServiceCommand,
  setup: Schema.optional(PluginServiceCommand),
  orb: Schema.Literals(PLUGIN_SERVICE_ORBS),
  /** Keep the plugin Orb running instead of sleeping after idle minutes. */
  keepRunning: Schema.Boolean,
  tools: Schema.optional(
    Schema.Array(PluginServiceTool).check(
      Schema.isMaxLength(MAX_PLUGIN_SERVICE_TOOLS),
    ),
  ),
  /**
   * The plugin's own page, served by the program under this path on its
   * port and opened in a frame under a dx header. Only this path prefix is
   * reachable from a browser. The reader checks the path's form
   * (`PLUGIN_SERVICE_APP_PATH`), so the web bundle carries no pattern.
   */
  app: Schema.optional(Schema.Struct({ path: Schema.String })),
  /**
   * An address on the internet for the program: Core answers
   * `/api/plugin-services/<install id>/http/*` and relays each request whose
   * bearer token the program issued (`PLUGIN_SERVICE_HTTP_TOKEN_PREFIX` keys
   * in its state) to `POST /http` on the program. Anything else is refused
   * before any Orb wakes.
   */
  http: Schema.optional(Schema.Boolean),
});

export type PluginService = typeof PluginService.Type;

/**
 * A schedule dx's scheduler runs. With a `service`, it wakes the plugin Orb
 * and sends `POST /jobs/<name>` to the service; without one, it sends the
 * plugin's function code a `job.run` event, with no Orb. `every` is 1m to
 * 30d; `cron` is five fields in UTC. No model runs.
 */
export const PluginServiceSchedule = Schema.Union([
  Schema.Struct({
    name: PluginJobId,
    every: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,4}[mhd]$/)),
  }),
  Schema.Struct({
    name: PluginJobId,
    cron: Schema.String.check(Schema.isMinLength(9), Schema.isMaxLength(100)),
  }),
]);

export type PluginServiceSchedule = typeof PluginServiceSchedule.Type;

/**
 * A listener. `run`: a command on the plugin Orb whose every output line is
 * one `POST /events/<name>` to the service (needs `service`). `url`: a
 * `wss://` WebSocket or `https://` server-sent event stream dx keeps open
 * inside dx, with no Orb, sending each message to the function code as a
 * `listener.event` event; its host must be in `permissions.network`.
 */
export const PluginServiceListener = Schema.Union([
  Schema.Struct({ name: PluginJobId, run: PluginServiceCommand }),
  Schema.Struct({
    name: PluginJobId,
    url: Schema.String.check(
      Schema.isMaxLength(2_048),
      Schema.isPattern(/^(?:wss|https):\/\/\S+$/),
    ),
  }),
]);

export type PluginServiceListener = typeof PluginServiceListener.Type;

/** Whether a listener runs a command on the plugin Orb (vs. a URL dx watches). */
export const isCommandListener = (
  listener: PluginServiceListener,
): listener is Extract<PluginServiceListener, { run: string }> =>
  "run" in listener;

/**
 * What a plugin's schedules, listeners, and service do, one plain line each:
 * the program, the Orb it asks for, each schedule, listener, and tool. A
 * changed command or URL is a new line, so an update that runs something
 * else asks again.
 */
export const pluginServiceGrants = (
  code:
    | {
        readonly service?: PluginService | undefined;
        readonly schedules?: ReadonlyArray<PluginServiceSchedule> | undefined;
        readonly listeners?: ReadonlyArray<PluginServiceListener> | undefined;
      }
    | undefined,
): ReadonlyArray<string> => {
  const service = code?.service;
  return [
    ...(service === undefined
      ? []
      : [
          `runs a program on a plugin Orb: ${service.run}`,
          ...(service.setup === undefined
            ? []
            : [`sets up with: ${service.setup}`]),
          ...(service.orb === "own" ? ["runs on an Orb of its own"] : []),
          ...(service.keepRunning ? ["keeps its Orb running"] : []),
        ]),
    ...(code?.schedules ?? []).map((schedule) =>
      "every" in schedule
        ? `runs ${schedule.name} every ${schedule.every}`
        : `runs ${schedule.name} on ${schedule.cron} (UTC)`,
    ),
    ...(code?.listeners ?? []).map((listener) =>
      isCommandListener(listener)
        ? `listens to ${listener.name}: ${listener.run}`
        : `listens to ${listener.name}: ${listener.url}`,
    ),
    ...(service?.tools ?? []).map(({ name }) => `answers the tool ${name}`),
    ...(service?.app === undefined
      ? []
      : [`serves its own page at ${service.app.path}`]),
    ...(service?.http === true
      ? [
          "has a URL reachable from the internet; requests need a token this plugin issues",
        ]
      : []),
  ];
};
