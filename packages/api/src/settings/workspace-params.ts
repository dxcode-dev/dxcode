import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";

/** The `:workspaceSlug` of a `/v1/settings/workspaces/:workspaceSlug/…` endpoint. */
export const WorkspaceSettingsParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});
