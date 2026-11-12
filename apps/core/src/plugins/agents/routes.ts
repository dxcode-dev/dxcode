import { PluginAgentModesResponseSchema } from "@dx/api";
import { Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { listOwnerPluginAgentModes } from "./modes.js";

/**
 * `GET /v1/plugin-agents/modes`: the agent modes the person's installed
 * plugins offer, for the new Thread composer. One D1 read; each plugin
 * describes itself from its warm worker's cache.
 */
export const pluginAgentRoutes = new Hono<AppEnv>();

pluginAgentRoutes.get("/modes", async (context) => {
  const db = context.env.DB;
  const principal = context.get("principal");
  const modes =
    db === undefined
      ? []
      : await listOwnerPluginAgentModes(context.env, db, principal.userId);
  context.header("cache-control", "private, max-age=0");
  return context.json(
    Schema.encodeUnknownSync(PluginAgentModesResponseSchema)({
      status: "ok",
      data: {
        modes: modes.map((mode) => ({
          mode: mode.agentMode,
          label: mode.label,
          ...(mode.description === undefined
            ? {}
            : { description: mode.description }),
          ...(mode.color === undefined ? {} : { color: mode.color }),
          plugin: mode.install.displayName,
          ...(mode.definition.model === undefined
            ? {}
            : { model: mode.definition.model }),
          ...(mode.definition.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: mode.definition.reasoningEffort }),
        })),
      },
    }),
  );
});
