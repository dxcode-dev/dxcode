import { D1Client } from "@effect/sql-d1";
import { Layer } from "effect";
import { SettingsAudit } from "../audit.js";
import { McpServerRepositoryD1 } from "../mcp-servers/repository-d1.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { SkillRepositoryD1 } from "./repository-d1.js";
import { SkillService } from "./service.js";

/**
 * Everything skill routes and the agent's `manage_skills` tool run on, over
 * one D1 database.
 */
export const skillLayers = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const skills = SkillRepositoryD1(db);
  const mcp = McpServerRepositoryD1(db);
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const audit = SettingsAudit.layer;
  const service = SkillService.layer.pipe(
    Layer.provide(Layer.mergeAll(skills, mcp, audit)),
  );
  return Layer.mergeAll(workspace, skills, mcp, settings, service, audit);
};
