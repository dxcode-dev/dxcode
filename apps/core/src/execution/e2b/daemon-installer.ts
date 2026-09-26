import type { ThreadId } from "@dx/domain";
import { Redacted, Schema } from "effect";
import ProfileHook from "../../../../dxd/assets/dx-terminal-profile.sh?raw";
import { SOURCE_WORKSPACE_CWD } from "../../source-control/source-workspace.js";
import {
  type DaemonGeneration,
  DXD_PROTOCOL_MAJOR,
  DXD_RELEASE,
} from "../dxd/protocol.js";

const STATE_DIRECTORY = "/home/user/.local/state/dxd";
const HEALTH_SOCKET = `${STATE_DIRECTORY}/health.sock`;
const MAX_OBSERVATION_BYTES = 64 * 1024;
const HEALTH_GENERATION_ATTEMPTS = 10;
const HEALTH_GENERATION_RETRY_MS = 250;
const PROFILE_HOOK_PATH = "/etc/profile.d/dx-terminal.sh";
const BASH_PROFILE_PATH = "/home/user/.bash_profile";
const BASHRC_PATH = "/home/user/.bashrc";

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
  readonly generation: DaemonGeneration;
  readonly apiKey: Redacted.Redacted<string>;
  readonly endpoint: string;
  readonly sha256: string;
  readonly loadBinary: () => Promise<Uint8Array>;
  readonly signal?: AbortSignal;
}

const Unit = `[Unit]
Description=dx daemon
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=user
Group=user
ExecStart=/usr/local/bin/dxd
Restart=always
RestartSec=2
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

const Health = Schema.Struct({
  release: Schema.Literal(DXD_RELEASE),
  protocolMajor: Schema.Literal(DXD_PROTOCOL_MAJOR),
  generation: Schema.String,
  connected: Schema.Boolean,
});

const boundedRandomPath = (name: string) =>
  `${STATE_DIRECTORY}/.${name}-${crypto.randomUUID()}`;

const arrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

export const ensureDaemonInGuest = async (
  guest: DaemonGuest,
  input: EnsureDaemonGuestInput,
): Promise<{
  release: typeof DXD_RELEASE;
  protocolMajor: typeof DXD_PROTOCOL_MAJOR;
  generation: DaemonGeneration;
}> => {
  const binaryTemp = boundedRandomPath("binary");
  const configTemp = boundedRandomPath("config");
  const unitTemp = boundedRandomPath("unit");
  const profileHookTemp = boundedRandomPath("profile-hook");
  const bashProfileTemp = boundedRandomPath("bash-profile");
  const bashrcTemp = boundedRandomPath("bashrc");
  const configuration = JSON.stringify({
    version: 1,
    endpoint: input.endpoint,
    threadId: input.threadId,
    generation: input.generation,
    apiKey: Redacted.value(input.apiKey),
    release: DXD_RELEASE,
    protocolMajor: DXD_PROTOCOL_MAJOR,
    workspaceRoot: SOURCE_WORKSPACE_CWD,
  });

  const installed = await guest.commands.run(
    `install -d -m 0700 -o user -g user ${STATE_DIRECTORY}
if test -f /usr/local/bin/dxd; then sha256sum /usr/local/bin/dxd; fi`,
    { timeoutMs: 10_000 },
  );
  const binaryCurrent =
    installed.stdout.trim() === `${input.sha256}  /usr/local/bin/dxd`;
  if (input.signal?.aborted) throw new Error("Daemon installation aborted.");
  const binary = binaryCurrent ? undefined : await input.loadBinary();
  if (input.signal?.aborted) throw new Error("Daemon installation aborted.");
  await Promise.all([
    ...(binary === undefined
      ? []
      : [guest.files.write(binaryTemp, arrayBuffer(binary))]),
    guest.files.write(configTemp, configuration),
    guest.files.write(unitTemp, Unit),
    guest.files.write(profileHookTemp, ProfileHook),
    guest.files.write(bashProfileTemp, BashProfile),
    guest.files.write(bashrcTemp, Bashrc),
  ]);

  // Values enter the guest only through files.write. This command contains
  // bounded random paths and public release metadata, never runtime config.
  if (input.signal?.aborted) throw new Error("Daemon installation aborted.");
  try {
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
chmod 0600 ${configTemp}
chmod 0644 ${unitTemp}
chmod 0644 ${profileHookTemp} ${bashProfileTemp} ${bashrcTemp}
chown user:user ${configTemp}
binary_changed=0; config_changed=0; unit_changed=0
profile_changed=0
${
  binaryCurrent
    ? `printf '%s  %s\n' '${input.sha256}' '/usr/local/bin/dxd' | sha256sum -c - >/dev/null`
    : `trap 'rm -f -- ${binaryTemp}; rm -rf -- "$lockdir"' EXIT
chmod 0755 ${binaryTemp}
printf '%s  %s\n' '${input.sha256}' '${binaryTemp}' | sha256sum -c - >/dev/null
if ! test -f /usr/local/bin/dxd || ! cmp -s ${binaryTemp} /usr/local/bin/dxd; then sudo install -o root -g root -m 0755 ${binaryTemp} /usr/local/bin/dxd; binary_changed=1; fi
rm -f ${binaryTemp}`
}
if ! test -f ${STATE_DIRECTORY}/config.json || ! cmp -s ${configTemp} ${STATE_DIRECTORY}/config.json; then mv -f ${configTemp} ${STATE_DIRECTORY}/config.json; config_changed=1; else rm -f ${configTemp}; fi
if ! test -f /etc/systemd/system/dxd.service || ! cmp -s ${unitTemp} /etc/systemd/system/dxd.service; then sudo install -o root -g root -m 0644 ${unitTemp} /etc/systemd/system/dxd.service; unit_changed=1; fi
rm -f ${unitTemp}
if ! test -f ${PROFILE_HOOK_PATH} || ! cmp -s ${profileHookTemp} ${PROFILE_HOOK_PATH}; then sudo install -o root -g root -m 0644 ${profileHookTemp} ${PROFILE_HOOK_PATH}; profile_changed=1; fi
rm -f ${profileHookTemp}
if ! test -e ${BASH_PROFILE_PATH} && ! test -L ${BASH_PROFILE_PATH}; then mv ${bashProfileTemp} ${BASH_PROFILE_PATH}; else rm -f ${bashProfileTemp}; fi
if ! test -e ${BASHRC_PATH} && ! test -L ${BASHRC_PATH}; then mv ${bashrcTemp} ${BASHRC_PATH}; else rm -f ${bashrcTemp}; fi
if test "$unit_changed" = 1; then sudo systemctl daemon-reload; fi
sudo systemctl enable dxd.service >/dev/null
if test "$binary_changed$config_changed$unit_changed$profile_changed" != 0000; then sudo systemctl restart dxd.service; else sudo systemctl start dxd.service; fi`,
      { timeoutMs: 30_000 },
    );
    if (install.exitCode !== 0) throw new Error("Daemon installation failed.");
  } catch {
    // systemd can report a transient command failure while a resumed guest is
    // already completing the requested restart. The exact-generation health
    // check below is the authority; partial installs cannot satisfy it.
  }

  for (let attempt = 0; attempt < HEALTH_GENERATION_ATTEMPTS; attempt += 1) {
    const healthResult = await guest.commands.run(
      `curl --silent --show-error --max-time 5 --retry 5 --retry-delay 1 --retry-all-errors --unix-socket ${HEALTH_SOCKET} http://localhost/health`,
      { timeoutMs: 10_000 },
    );
    if (
      healthResult.exitCode !== 0 ||
      new TextEncoder().encode(healthResult.stdout).byteLength >
        MAX_OBSERVATION_BYTES
    )
      throw new Error("Daemon health check failed.");
    let raw: unknown;
    try {
      raw = JSON.parse(healthResult.stdout);
    } catch {
      throw new Error("Daemon health check returned invalid JSON.");
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !==
        "connected,generation,protocolMajor,release"
    )
      throw new Error("Daemon health check returned an invalid result.");
    const health = Schema.decodeUnknownSync(Health)(raw);
    if (health.generation === input.generation)
      return { ...health, generation: input.generation };
    if (input.signal?.aborted) throw new Error("Daemon installation aborted.");
    if (attempt + 1 < HEALTH_GENERATION_ATTEMPTS)
      await new Promise((resolve) =>
        setTimeout(resolve, HEALTH_GENERATION_RETRY_MS),
      );
  }
  throw new Error("Daemon health check did not match requested generation.");
};

export const DXD_SYSTEMD_UNIT = Unit;
export const DXD_PROFILE_HOOK = ProfileHook;
export const DXD_DEFAULT_BASH_PROFILE = BashProfile;
export const DXD_DEFAULT_BASHRC = Bashrc;
