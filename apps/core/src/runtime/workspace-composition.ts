import { Effect, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import {
  loadRuntimeConfiguration,
  selectRuntimeAdapters,
} from "./composition.js";

export class ResidentRuntimeUnavailable extends Schema.TaggedError<ResidentRuntimeUnavailable>()(
  "ResidentRuntimeUnavailable",
  {},
) {}

export const unavailableResidentRuntime = () => {
  throw new ResidentRuntimeUnavailable();
};

export const selectWorkspaceRuntime = <WorkspaceRuntime>(
  bindings: Bindings,
  runtimes: {
    readonly local: WorkspaceRuntime;
    readonly deployed: WorkspaceRuntime;
  },
) =>
  selectRuntimeAdapters(Effect.runSync(loadRuntimeConfiguration(bindings)), {
    local: { execution: runtimes.local, model: undefined },
    deployed: { execution: runtimes.deployed, model: undefined },
  }).execution;
