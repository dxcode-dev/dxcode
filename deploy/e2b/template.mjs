import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Template, waitForFile } from "e2b";

// The dx workspace template is the standard Orb image
// (deploy/orb/Dockerfile), built by E2B from the same Dockerfile, so E2B and
// Cloudflare Containers run the same filesystem. E2B does not use the image
// ENTRYPOINT (tini is for containers without an init); its start command
// runs the same entrypoint script once at build time, and the template
// snapshot keeps it running in every sandbox. The build waits until the
// entrypoint has written its PID file.
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const dockerfile = readFileSync(
  new URL("../orb/Dockerfile", import.meta.url),
  "utf8",
);

export const dxWorkspaceTemplate = Template({ fileContextPath: repositoryRoot })
  .fromDockerfile(dockerfile)
  .setStartCmd(
    "/usr/local/bin/dx-orb-init",
    waitForFile("/home/user/.local/state/dxd/supervisor.pid"),
  );

// Runner-size aliases retain the exact prepared dx template. Resource limits
// are selected only when each alias is built by the deployment wrapper.
export const dxOrbTemplate = (baseTemplate) =>
  Template().fromTemplate(baseTemplate);
