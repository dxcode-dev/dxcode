import type { ThreadId } from "@dx/domain";
import { Redacted } from "effect";
import ProfileStub from "../../../../dxd/assets/dx-terminal-stub.sh?raw";
import { SOURCE_WORKSPACE_CWD } from "../../source-control/source-workspace.js";
import {
  DXD_PROTOCOL_MAJOR,
  type DxdRuntimeConfiguration,
} from "../dxd/protocol.js";

/**
 * Bootstrap of the resident daemon in an E2B guest.
 *
 * This runs only when no daemon registered on its own. Its first command
 * inspects the guest and, when a current-protocol daemon is installed and
 * configured, only nudges it (SIGHUP, or a start when it is down): one guest
 * command. The release itself is the daemon's business: Core names it after
 * every registration and the daemon swaps in place, keeping its shell.
 *
 * Everything else gets the full install: a brand-new sandbox, a lost
 * configuration, or a guest from before protocol 2 (`main`: config version
 * 1, a root-owned `/usr/local/bin/dxd`, and a tmux-hosted shell). A running
 * daemon is restarted only when its binary cannot speak this protocol, once.
 * The binary and configuration are owned by the `user` account so the daemon
 * can update itself; the systemd unit and the static login hook are the only
 * root-owned pieces. The login hook is a stub that sources the shell profile
 * dxd writes and versions itself, so no release depends on a root-owned file
 * changing.
 */

const STATE_DIRECTORY = "/home/user/.local/state/dxd";
const BINARY_PATH = `${STATE_DIRECTORY}/bin/dxd`;
const CONFIG_PATH = `${STATE_DIRECTORY}/config.json`;
const PROFILE_STUB_PATH = "/etc/profile.d/dx-terminal.sh";
// An earlier installer left an upgrade notice here for the next shell to
// print; the inspection removes both so no shell shows it.
const LEGACY_NOTICE_HOOK_PATH = "/etc/profile.d/dx-terminal-notice.sh";
const LEGACY_NOTICE_PATH = `${STATE_DIRECTORY}/terminal-notice`;
const UNIT_PATH = "/etc/systemd/system/dxd.service";
const BASH_PROFILE_PATH = "/home/user/.bash_profile";
const BASHRC_PATH = "/home/user/.bashrc";
const MAX_OBSERVATION_BYTES = 64 * 1024;

export interface DaemonGuest {
  readonly files: {
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
  };
  readonly commands: {
    run(
      command: string,
      options: { readonly timeoutMs: number },
    ): Promise<{ readonly stdout: string; readonly exitCode: number }>;
  };
}

export interface EnsureDaemonGuestInput {
  readonly threadId: ThreadId;
  readonly endpoint: string;
  readonly sha256: string;
  readonly releaseUrl: string;
  /** Fallback when the guest cannot download the release itself. */
  readonly loadBinary: () => Promise<Uint8Array>;
  readonly credential?: {
    readonly id: string;
    readonly key: Redacted.Redacted<string>;
  };
  readonly mintCredential: () => Promise<{
    readonly id: string;
    readonly key: Redacted.Redacted<string>;
  }>;
  readonly signal?: AbortSignal;
}

// RestartSec is short because a restarted dxd is what tells the browser that
// the shell died with the old process (Terminal "exited" with Restart).
const Unit = `[Unit]
Description=dx daemon
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=user
Group=user
ExecStart=${BINARY_PATH}
Restart=always
RestartSec=500ms
UMask=0077

[Install]
WantedBy=multi-user.target
`;

const BashProfile = `if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
`;

const Bashrc = `case $- in
  *i*) PS1='\\w \\$ ' ;;
esac
`;

// The executable the running daemon was started from; empty when it is down.
// systemctl needs sudo here: the guest user has no systemd bus.
const RunningDaemon = `pid=$(sudo systemctl show dxd.service -p MainPID --value 2>/dev/null || echo 0)
running=$(test "$pid" -gt 0 2>/dev/null && readlink /proc/$pid/exe 2>/dev/null || true)`;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

const sha256 = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

const boundedRandomPath = (name: string) =>
  `${STATE_DIRECTORY}/.${name}-${crypto.randomUUID()}`;

const arrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

/** What a guest bootstrap did. */
export type DaemonGuestOutcome =
  /** A current daemon was only nudged: one guest command. */
  | "nudged"
  /** Installed or repaired without replacing a running daemon. */
  | "installed"
  /** A running pre-protocol-2 daemon was replaced; its shell ended. */
  | "upgraded";

interface GuestState {
  readonly binaryCurrent: boolean;
  /** A version-2 configuration; older documents are replaced. */
  readonly configPresent: boolean;
}

/**
 * One command: report the installation, and nudge the daemon when nothing
 * needs installing. Returns `undefined` after a nudge.
 */
const inspectGuest = async (
  guest: DaemonGuest,
  sha256Hex: string,
  nudge: boolean,
): Promise<GuestState | undefined> => {
  const [unitSha, stubSha] = await Promise.all([
    sha256(Unit),
    sha256(ProfileStub),
  ]);
  const inspected = await guest.commands.run(
    `install -d -m 0700 ${STATE_DIRECTORY} ${STATE_DIRECTORY}/bin
rm -f ${LEGACY_NOTICE_PATH}
if test -e ${LEGACY_NOTICE_HOOK_PATH}; then sudo rm -f ${LEGACY_NOTICE_HOOK_PATH}; fi
binary=none; protocol=none; config=no-config
if test -f ${BINARY_PATH}; then binary=$(sha256sum ${BINARY_PATH} | cut -d' ' -f1); fi
if test -x ${BINARY_PATH}; then protocol=$(${BINARY_PATH} --version 2>/dev/null | sed -n 's/^dxd [^ ]* protocol //p'); fi
if test -f ${CONFIG_PATH} && grep -q '"version":2' ${CONFIG_PATH}; then config=config; fi
${RunningDaemon}
${
  nudge
    ? `if test "$running" = ${BINARY_PATH} && test "$protocol" = ${DXD_PROTOCOL_MAJOR} && test "$config" = config && test "$(sha256sum ${UNIT_PATH} 2>/dev/null | cut -d' ' -f1)" = ${unitSha} && test "$(sha256sum ${PROFILE_STUB_PATH} 2>/dev/null | cut -d' ' -f1)" = ${stubSha}; then
  sudo systemctl kill --signal=SIGHUP --kill-whom=main dxd.service
  echo nudged; exit 0
fi`
    : ""
}
echo "$binary"; echo "$config"`,
    { timeoutMs: 10_000 },
  );
  if (
    inspected.exitCode !== 0 ||
    new TextEncoder().encode(inspected.stdout).byteLength >
      MAX_OBSERVATION_BYTES
  )
    throw new Error("Daemon guest inspection failed.");
  const lines = inspected.stdout.trim().split("\n");
  if (lines[0] === "nudged") return undefined;
  return {
    binaryCurrent: lines[0] === sha256Hex,
    configPresent: lines[1] === "config",
  };
};

export const ensureDaemonInGuest = async (
  guest: DaemonGuest,
  input: EnsureDaemonGuestInput,
): Promise<DaemonGuestOutcome> => {
  // A new credential must reach the configuration, so it never just nudges.
  const state = await inspectGuest(
    guest,
    input.sha256,
    input.credential === undefined,
  );
  if (state === undefined) return "nudged";
  if (input.signal?.aborted) throw new Error("Daemon installation aborted.");

  const credential =
    input.credential ??
    (state.configPresent ? undefined : await input.mintCredential());
  const configTemp =
    credential === undefined ? undefined : boundedRandomPath("config");
  if (configTemp !== undefined && credential !== undefined) {
    const configuration: DxdRuntimeConfiguration = {
      version: 2,
      endpoint: input.endpoint,
      threadId: input.threadId,
      apiKey: Redacted.value(credential.key),
      workspaceRoot: SOURCE_WORKSPACE_CWD,
    };
    await guest.files.write(configTemp, JSON.stringify(configuration));
  }

  const binaryTemp = state.binaryCurrent
    ? undefined
    : boundedRandomPath("binary");
  if (binaryTemp !== undefined) {
    // The guest fetches the release directly; the Worker only streams the
    // bytes itself when the guest cannot reach the release host. The E2B SDK
    // rejects a non-zero exit instead of returning it, so both count as failed.
    const fetched = await guest.commands
      .run(
        `curl -fsSL --max-time 120 --retry 5 --retry-delay 1 --retry-all-errors -o ${binaryTemp} '${input.releaseUrl}' && printf '%s  %s\n' '${input.sha256}' '${binaryTemp}' | sha256sum -c - >/dev/null && echo ok`,
        { timeoutMs: 150_000 },
      )
      .catch(() => undefined);
    if (fetched?.exitCode !== 0 || fetched.stdout.trim() !== "ok") {
      if (input.signal?.aborted)
        throw new Error("Daemon installation aborted.");
      const binary = await input.loadBinary();
      await guest.files.write(binaryTemp, arrayBuffer(binary));
    }
  }

  const unitTemp = boundedRandomPath("unit");
  const profileStubTemp = boundedRandomPath("profile-stub");
  const bashProfileTemp = boundedRandomPath("bash-profile");
  const bashrcTemp = boundedRandomPath("bashrc");
  await Promise.all([
    guest.files.write(unitTemp, Unit),
    guest.files.write(profileStubTemp, ProfileStub),
    guest.files.write(bashProfileTemp, BashProfile),
    guest.files.write(bashrcTemp, Bashrc),
  ]);
  if (input.signal?.aborted) throw new Error("Daemon installation aborted.");

  // Values enter the guest only through files.write. This command contains
  // bounded random paths and public release metadata, never runtime config.
  const install = await guest.commands.run(
    `lockdir=${STATE_DIRECTORY}/install.lock.d
while ! mkdir "$lockdir" 2>/dev/null; do
  holder=$(cat "$lockdir/pid" 2>/dev/null || true)
  if test -n "$holder" && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf -- "$lockdir"; continue
  fi
  if test -z "$holder"; then
    stamp=$(stat -c %Y "$lockdir" 2>/dev/null || echo 0)
    test "$(($(date +%s) - stamp))" -gt 30 && rm -rf -- "$lockdir"
  fi
  sleep 0.1
done
echo $$ >"$lockdir/pid"
trap 'rm -rf -- "$lockdir"' EXIT
set -eu
chmod 0644 ${unitTemp} ${profileStubTemp} ${bashProfileTemp} ${bashrcTemp}
# Only a daemon from before protocol ${DXD_PROTOCOL_MAJOR} (running from another path) is
# replaced while it runs. A current one keeps its process and shell and swaps
# releases itself, even when its file was replaced ("… (deleted)").
${RunningDaemon}
restart=0
case "$running" in ""|${BINARY_PATH}*) ;; *) restart=1 ;; esac
${
  binaryTemp === undefined
    ? ""
    : `chmod 0755 ${binaryTemp}
printf '%s  %s\n' '${input.sha256}' '${binaryTemp}' | sha256sum -c - >/dev/null
mv -f ${binaryTemp} ${BINARY_PATH}`
}
${
  configTemp === undefined
    ? ""
    : `chmod 0600 ${configTemp}
mv -f ${configTemp} ${CONFIG_PATH}`
}
if ! test -f ${UNIT_PATH} || ! cmp -s ${unitTemp} ${UNIT_PATH}; then sudo install -o root -g root -m 0644 ${unitTemp} ${UNIT_PATH}; sudo systemctl daemon-reload; fi
rm -f ${unitTemp}
if ! test -f ${PROFILE_STUB_PATH} || ! cmp -s ${profileStubTemp} ${PROFILE_STUB_PATH}; then sudo install -o root -g root -m 0644 ${profileStubTemp} ${PROFILE_STUB_PATH}; fi
rm -f ${profileStubTemp}
if ! test -e ${BASH_PROFILE_PATH} && ! test -L ${BASH_PROFILE_PATH}; then mv ${bashProfileTemp} ${BASH_PROFILE_PATH}; else rm -f ${bashProfileTemp}; fi
if ! test -e ${BASHRC_PATH} && ! test -L ${BASHRC_PATH}; then mv ${bashrcTemp} ${BASHRC_PATH}; else rm -f ${bashrcTemp}; fi
if test "$(readlink /usr/local/bin/dxd 2>/dev/null)" != "${BINARY_PATH}"; then sudo ln -sfn ${BINARY_PATH} /usr/local/bin/dxd; fi
sudo systemctl enable dxd.service >/dev/null
# A running daemon owns the Terminal shell. It re-reads its configuration and
# reconnects on SIGHUP; only an incompatible one is replaced, once.
if test -z "$running"; then
  sudo systemctl start dxd.service; echo installed
elif test "$restart" = 1; then
  sudo systemctl restart dxd.service; echo upgraded
else
  sudo systemctl kill --signal=SIGHUP --kill-whom=main dxd.service; echo installed
fi`,
    { timeoutMs: 30_000 },
  );
  if (install.exitCode !== 0) throw new Error("Daemon installation failed.");
  return install.stdout.trim().endsWith("upgraded") ? "upgraded" : "installed";
};

export const DXD_SYSTEMD_UNIT = Unit;
export const DXD_PROFILE_STUB = ProfileStub;
export const DXD_DEFAULT_BASH_PROFILE = BashProfile;
export const DXD_DEFAULT_BASHRC = Bashrc;
export const DXD_GUEST_BINARY_PATH = BINARY_PATH;
export const DXD_GUEST_CONFIG_PATH = CONFIG_PATH;
