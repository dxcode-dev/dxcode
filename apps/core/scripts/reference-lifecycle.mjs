import { Effect } from "effect";
import { loadReferenceLifecycleConfig } from "../src/dev/reference-lifecycle/config.ts";
import {
  formatReferenceLifecycleError,
  runReferenceLifecycle,
} from "../src/dev/reference-lifecycle/workflow.ts";

try {
  const config = await Effect.runPromise(
    loadReferenceLifecycleConfig(process.env),
  );
  const evidence = await runReferenceLifecycle(config);
  console.log(JSON.stringify({ status: "success", evidence }));
} catch (error) {
  console.error(formatReferenceLifecycleError(error));
  process.exitCode = 1;
}
