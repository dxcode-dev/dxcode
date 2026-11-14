import { D1Client } from "@effect/sql-d1";
import { Layer } from "effect";
import { coalescingD1 } from "../../../persistence/d1-coalesce.js";
import {
  D1WriteBatch,
  deferredWritesD1,
} from "../../../persistence/d1-deferred-writes.js";
import { PluginTrustPoliciesD1 } from "../../../plugins/trust/policy.js";
import { SettingsAudit } from "../../audit.js";
import { EnvironmentVariableRepositoryD1 } from "../../environment-variables/repository-d1.js";
import { McpServerRepositoryD1 } from "../../mcp-servers/repository-d1.js";
import { McpServerService } from "../../mcp-servers/service.js";
import { SettingsService } from "../../service.js";
import { SkillRepositoryD1 } from "../../skills/repository-d1.js";
import { SkillService } from "../../skills/service.js";
import { WorkspaceRepositoryD1 } from "../../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../../workspace-policy/service.js";
import { PluginCatalogRepositoryD1 } from "../catalogs/repository-d1.js";
import { PluginPackageStore } from "./plugin-package.js";
import { PluginBundleRepositoryD1 } from "./repository-d1.js";
import { PluginBundleService } from "./service.js";
import { PluginShareLinksD1 } from "./share-links.js";
import { PluginSignaturesD1 } from "./signature.js";

/** Everything plugin bundle routes and the agent's proposals run on. */
export const pluginBundleLayers = (
  binding: D1Database,
  storage: R2Bucket | undefined,
  options: {
    /**
     * Hold every write back for one atomic batch that the service sends at
     * its commit point (install and update). Off: writes go straight out.
     */
    readonly deferWrites?: boolean;
  } = {},
) => {
  const writes =
    options.deferWrites === true
      ? // Reads before the commit still go out together.
        deferredWritesD1(coalescingD1(binding))
      : undefined;
  const db = writes?.db ?? binding;
  const writeBatch =
    writes === undefined
      ? D1WriteBatch.immediate
      : D1WriteBatch.deferred(writes);
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const environment = EnvironmentVariableRepositoryD1(db);
  const mcp = McpServerRepositoryD1(db);
  const skills = SkillRepositoryD1(db);
  const bundles = PluginBundleRepositoryD1(db);
  const catalogs = PluginCatalogRepositoryD1(db);
  const shares = PluginShareLinksD1(db);
  const signatures = PluginSignaturesD1(db);
  const policy = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  const mcpService = McpServerService.layer.pipe(
    Layer.provide(Layer.mergeAll(environment, mcp, SettingsAudit.layer)),
  );
  const skillService = SkillService.layer.pipe(
    Layer.provide(Layer.mergeAll(skills, mcp, SettingsAudit.layer)),
  );
  const service = PluginBundleService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        bundles,
        catalogs,
        skills,
        skillService,
        mcp,
        mcpService,
        policy,
        shares,
        signatures,
        SettingsAudit.layer,
        PluginPackageStore.r2(storage),
        writeBatch,
      ),
    ),
  );
  return Layer.mergeAll(
    WorkspacePolicyRepositoryD1(db),
    shares,
    signatures,
    PluginTrustPoliciesD1(db),
    workspace,
    settings,
    bundles,
    catalogs,
    skills,
    mcp,
    policy,
    service,
    SettingsAudit.layer,
  );
};
