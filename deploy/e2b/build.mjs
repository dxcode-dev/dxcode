import { defaultBuildLogger, Template } from "e2b";
import { dxWorkspaceTemplate } from "./template.mjs";

// Builds the dx workspace template on the operator's E2B account and prints
// the exact values deploy.selfhost.json needs. Usage:
//   E2B_API_KEY=... node deploy/e2b/build.mjs [template-name]
const name = process.argv[2] ?? "dx-workspace";
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name))
  throw new Error(`Invalid template name: ${name}`);
if (!process.env.E2B_API_KEY?.trim())
  throw new Error("E2B_API_KEY is required.");

const build = await Template.build(dxWorkspaceTemplate, name, {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
});

console.log(`\nTemplate built: ${build.name} (${build.buildId})`);
console.log(`\nAdd to deploy.selfhost.json:\n  "e2bTemplate": "${build.name}"`);
