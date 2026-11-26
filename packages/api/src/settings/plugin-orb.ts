import { RunnerProfileId } from "@dx/domain";
import { Schema } from "effect";
import { successResponse } from "../http/response.js";

/**
 * Where plugins' services run: an Orb size, chosen in Settings → Orb
 * Providers → Plugins by the person or their workspace's admins, or on one
 * plugin's details for that plugin alone. `GET` and `PUT` at
 * `/v1/settings/personal/plugin-orb`,
 * `/v1/settings/workspaces/:workspaceSlug/plugin-orb`, and
 * `/v1/settings/plugin-orb/plugins/:pluginId`.
 *
 * A personal install resolves the plugin's own choice, then the person's,
 * then the workspace's, then the deployment's default; a workspace install
 * the plugin's own, then the workspace's, then the deployment's. With none,
 * its service is refused with where to choose one.
 */

export const PluginOrbSourceSchema = Schema.Literals([
  "plugin",
  "personal",
  "workspace",
  "deployment",
]);

export type PluginOrbSource = typeof PluginOrbSourceSchema.Type;

/** A plugin Orb that exists now, for "Runs on" and the payer line. */
export const PluginOrbStatusSchema = Schema.Struct({
  /** The size it pinned when it started; a new choice applies to a new Orb. */
  runnerProfileId: RunnerProfileId,
  /**
   * Who pays on an account dx bills for: the person who installed the
   * plugins it runs. On a person's or workspace's own key dx charges nothing.
   */
  payer: Schema.Struct({
    userId: Schema.String,
    name: Schema.String,
  }),
  state: Schema.Literals(["active", "stopped", "removing"]),
  /** Why a stopped Orb is not running, in plain words. */
  stoppedReason: Schema.optional(Schema.String),
  /** How many installs run on it. */
  services: Schema.Int,
  /**
   * Its Orb time this calendar month (UTC): minutes kept alive and what dx
   * priced them at, in millionths of a dollar (0 on a person's or
   * workspace's own key, which its provider bills).
   */
  month: Schema.Struct({ minutes: Schema.Int, costMicros: Schema.Int }),
});

export type PluginOrbStatus = typeof PluginOrbStatusSchema.Type;

export const PluginOrbDataSchema = Schema.Struct({
  /** This scope's choice; null when it chose none. */
  runnerProfileId: Schema.NullOr(RunnerProfileId),
  /** Whether the caller can change this scope's choice. */
  canUpdate: Schema.Boolean,
  /** What a service in this scope runs on now, and who chose it. */
  effective: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("orb"),
      runnerProfileId: RunnerProfileId,
      source: PluginOrbSourceSchema,
    }),
    Schema.Struct({ kind: Schema.Literal("none") }),
  ]),
  /**
   * The plugin Orb running for this scope, when one exists: for a workspace,
   * the one that runs the plugins the caller installed.
   */
  orb: Schema.optional(PluginOrbStatusSchema),
});

export type PluginOrbData = typeof PluginOrbDataSchema.Type;

export const PluginOrbResponseSchema = successResponse(PluginOrbDataSchema);

/** `PUT`: an Orb size, or null to choose none. */
export const UpdatePluginOrbRequestSchema = Schema.Struct({
  runnerProfileId: Schema.NullOr(RunnerProfileId),
});

export type UpdatePluginOrbRequest =
  typeof UpdatePluginOrbRequestSchema.Encoded;

/** The message a refused service shows: where to choose an Orb. */
export const PLUGIN_ORB_UNAVAILABLE_MESSAGE =
  "This plugin runs a program on an Orb, and none is chosen. Choose one in Settings → Orb Providers → Plugins, or ask your workspace admin to choose one for the workspace.";
