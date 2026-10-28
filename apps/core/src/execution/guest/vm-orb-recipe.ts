import orbHostname from "../../../../../deploy/orb/dx-orb-hostname.sh?raw";
import orbInit from "../../../../../deploy/orb/dx-orb-init?raw";
import orbTmuxConfig from "../../../../../deploy/orb/tmux.conf?raw";
import vmSetup from "../../../../../deploy/orb/vm-setup.sh?raw";
import terminalStub from "../../../../dxd/assets/dx-terminal-stub.sh?raw";

/**
 * The dx Orb on a plain Linux VM or container, for providers that boot
 * their own images rather than an OCI image (deploy/orb/vm-setup.sh). A
 * provider's preparation creates a machine from its Debian or Ubuntu base, writes these
 * files, starts the setup, polls its status, and snapshots the VM once it
 * is done; Threads then boot from that snapshot.
 */

const DIRECTORY = "/var/lib/dx-orb-setup";

/** What the recipe needs of a VM: root commands and file writes. */
export interface VmOrbBuildGuest {
  readonly runAsRoot: (
    command: string,
    timeoutMs: number,
  ) => Promise<{ readonly stdout: string; readonly exitCode: number }>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
}

const FILES: ReadonlyArray<readonly [string, string]> = [
  [`${DIRECTORY}/vm-setup.sh`, vmSetup],
  [`${DIRECTORY}/files/dx-terminal.sh`, terminalStub],
  [`${DIRECTORY}/files/dx-orb-init`, orbInit],
  [`${DIRECTORY}/files/dx-orb-hostname.sh`, orbHostname],
  [`${DIRECTORY}/files/tmux.conf`, orbTmuxConfig],
];

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * The recipe version (16 hex): the setup script, the files it installs,
 * and what the provider adds (its sizes, its base snapshots). A new version
 * prepares new snapshots; pinned Threads keep theirs.
 */
export const vmOrbRecipe = async (provider: string) =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode([...FILES.flat(), provider].join("\0")),
    ),
  ).slice(0, 16);

/** Writes the recipe into the VM and starts it in the background. */
export const startVmOrbSetup = async (guest: VmOrbBuildGuest) => {
  await guest.runAsRoot(`mkdir -p ${DIRECTORY}/files`, 30_000);
  for (const [path, content] of FILES) await guest.writeFile(path, content);
  const started = await guest.runAsRoot(
    `chmod 0755 ${DIRECTORY}/vm-setup.sh && echo starting >${DIRECTORY}/status && setsid nohup bash ${DIRECTORY}/vm-setup.sh ${DIRECTORY}/files ${DIRECTORY} >${DIRECTORY}/setup.log 2>&1 </dev/null & echo started`,
    30_000,
  );
  if (started.exitCode !== 0 || !started.stdout.includes("started"))
    throw new Error("The Orb setup did not start in the VM.");
};

export type VmOrbSetupStatus =
  | { readonly state: "running" }
  | { readonly state: "done" }
  | { readonly state: "failed"; readonly log: string };

/** Where the setup stands; a failure carries the end of its log. */
export const vmOrbSetupStatus = async (
  guest: VmOrbBuildGuest,
): Promise<VmOrbSetupStatus> => {
  const result = await guest.runAsRoot(
    `cat ${DIRECTORY}/status 2>/dev/null || echo missing`,
    30_000,
  );
  const state = result.stdout.trim();
  if (state === "done") return { state: "done" };
  if (state === "running" || state === "starting") return { state: "running" };
  const log = await guest
    .runAsRoot(`tail -c 400 ${DIRECTORY}/setup.log 2>/dev/null`, 30_000)
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
  return { state: "failed", log };
};
