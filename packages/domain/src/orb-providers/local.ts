import { Schema } from "effect";
import { RunnerProfileFields } from "../settings/runner-profile-fields.js";
import { defineOrbProvider } from "./descriptor.js";

export const LocalRunnerProfileConfiguration = Schema.Struct({
  ...RunnerProfileFields,
  adapter: Schema.Literal("local"),
});

export type LocalRunnerProfileConfiguration =
  typeof LocalRunnerProfileConfiguration.Type;

/** `pnpm dev`'s workspace runtime: a process on the developer's machine. */
export const localOrbProvider = defineOrbProvider({
  id: "local",
  displayName: "Local runtime",
  capabilities: ["execution.workspace", "execution.resident-daemon"],
  remote: false,
  development: true,
  profile: LocalRunnerProfileConfiguration,
  isolation: "process",
  requiredCapabilities: [
    "git",
    "environment-variables",
    "persistent-workspace",
  ],
  forbiddenCapabilities: ["internet-access", "pause-resume"],
  // The local runtime lists exactly the sizes `DX_RUNNER_PROFILE_CATALOG` names.
  sizes: [],
});
