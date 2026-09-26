import { Template } from "e2b";

// The dx workspace image. E2B sandboxes boot systemd as init, so the
// daemon installer's `sudo systemctl` calls work against a live manager.
// Every binary asserted below is invoked by
// apps/core/src/execution/e2b/daemon-installer.ts or by dxd itself.
export const dxWorkspaceTemplate = Template()
  .fromBaseImage()
  .aptInstall(["systemd", "sudo", "tmux", "ripgrep", "jq", "ca-certificates"])
  .runCmd(
    [
      "set -euxo pipefail",
      "for bin in systemctl sudo curl sha256sum install cmp tmux git python3 bash; do",
      '  command -v "$bin" >/dev/null || { echo "missing required binary: $bin"; exit 1; }',
      "done",
      "python3 --version",
      "git --version",
    ].join("\n"),
  );

// Runner-size aliases retain the exact prepared dx template. Resource limits
// are selected only when each alias is built by the deployment wrapper.
export const dxOrbTemplate = (baseTemplate) =>
  Template().fromTemplate(baseTemplate);
