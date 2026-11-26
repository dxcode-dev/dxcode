#!/usr/bin/env node
// Deletes the retired plugin container class from a stage's Orb Worker now,
// instead of at its next recipe change: redeploys the Orb Worker with the
// owner-approved `v4-remove-plugin-container` migration when nothing binds
// the class, else keeps it and says why (deploy/orb/containers.mjs,
// `pluginContainerRetirement`). A redeploy restarts every Orb container
// object, so run it when few Threads are active.
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… DX_DEPLOYMENT_ENVIRONMENT=staging \
//     node deploy/orb/retire-plugin-container.mjs <orb worker name> <core worker name>
import { resolve } from "node:path";
import { deployOrbWorker } from "./containers.mjs";

const [workerName, coreWorkerName] = process.argv.slice(2);
if (workerName === undefined || coreWorkerName === undefined) {
  process.stderr.write(
    "Usage: node deploy/orb/retire-plugin-container.mjs <orb worker name> <core worker name>\n",
  );
  process.exit(2);
}
const workspaceRoot = resolve(import.meta.dirname, "../..");
const { pluginContainerDeleted } = await deployOrbWorker({
  workerName,
  coreWorkerName,
  workspaceRoot,
  stateDirectory: resolve(workspaceRoot, ".dx/alchemy/orb", workerName),
});
process.stdout.write(
  pluginContainerDeleted
    ? `${workerName}: PluginContainerObject deleted (or already gone).\n`
    : `${workerName}: PluginContainerObject kept; see the reason above.\n`,
);
