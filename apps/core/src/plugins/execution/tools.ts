import type { SandboxFactory } from "@flue/runtime";
import { createFileTools } from "./files/tools.js";
import { createShellTools } from "./shell/tools.js";

/**
 * The Execution plugin's contribution for `execution.workspace`: the tools
 * every agent with a workspace receives, whatever the provider. Reading and
 * searching go through shell_command. They mount with the workspace, need no
 * per-submission resolution, and are not metered.
 */
export const executionWorkspaceTools: NonNullable<SandboxFactory["tools"]> = (
  sandbox,
) => [...createShellTools(sandbox), ...createFileTools(sandbox)];
