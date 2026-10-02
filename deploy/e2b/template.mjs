import { readFileSync } from "node:fs";
import { Template } from "e2b";

// The static root login hook. It only sources the shell profile dxd writes
// and versions itself, so no dxd release needs to change it. Core's
// installer writes the same file for guests built before it was baked in.
const profileStub = readFileSync(
  new URL("../../apps/dxd/assets/dx-terminal-stub.sh", import.meta.url),
);
export const installProfileStub = `printf '%s' '${profileStub.toString("base64")}' | base64 -d >/etc/profile.d/dx-terminal.sh && chmod 0644 /etc/profile.d/dx-terminal.sh`;

// The dx workspace image. E2B sandboxes boot systemd as init, so the
// daemon installer's `sudo systemctl` calls work against a live manager.
// Every binary asserted below is invoked by
// apps/core/src/execution/e2b/daemon-installer.ts or by dxd itself.
export const dxWorkspaceTemplate = Template()
  .fromBaseImage()
  .aptInstall(["systemd", "sudo", "ripgrep", "jq", "ca-certificates"])
  .runCmd(
    [
      "set -euxo pipefail",
      "for bin in systemctl sudo curl sha256sum install cmp git bash; do",
      '  command -v "$bin" >/dev/null || { echo "missing required binary: $bin"; exit 1; }',
      "done",
      "git --version",
    ].join("\n"),
  )
  .runCmd(installProfileStub, { user: "root" });

// Runner-size aliases retain the exact prepared dx template. Resource limits
// are selected only when each alias is built by the deployment wrapper.
export const dxOrbTemplate = (baseTemplate) =>
  Template().fromTemplate(baseTemplate);
