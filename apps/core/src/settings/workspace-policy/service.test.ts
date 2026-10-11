import { defaultWorkspacePolicy, WorkspaceId } from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { workspacePolicyDenial } from "./service.js";

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("policy-workspace");

describe("workspacePolicyDenial", () => {
  it("denies personal Orb keys until the workspace explicitly opts in", () => {
    const execution = {
      kind: "plugin.use-personal-override",
      pluginId: "execution",
    } as const;
    const search = { ...execution, pluginId: "search" } as const;
    const defaults = defaultWorkspacePolicy(workspaceId);
    // The general flag defaults to true; it is not an opt-in for Execution.
    expect(defaults.restrictions.allowPersonalPluginOverrides).toBe(true);
    expect(workspacePolicyDenial(defaults, search)).toBeUndefined();
    expect(workspacePolicyDenial(defaults, execution)).toMatchObject({
      reason: "personal-plugin-overrides-disabled",
    });
    const optedIn = {
      ...defaults,
      restrictions: {
        ...defaults.restrictions,
        allowPersonalExecutionOverrides: true,
      },
    };
    expect(workspacePolicyDenial(optedIn, execution)).toBeUndefined();
    // The opt-in applies only together with the general flag.
    expect(
      workspacePolicyDenial(
        {
          ...optedIn,
          restrictions: {
            ...optedIn.restrictions,
            allowPersonalPluginOverrides: false,
          },
        },
        execution,
      ),
    ).toMatchObject({ reason: "personal-plugin-overrides-disabled" });
  });
});
