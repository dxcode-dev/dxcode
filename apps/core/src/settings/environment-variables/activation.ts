import { isReservedEnvironmentVariableName } from "@dx/domain";
import { Redacted, Schema } from "effect";
import { encodeBase64Url } from "../../encoding/base64.js";
import {
  DXD_ENVIRONMENT_MAX_ENTRIES,
  DXD_ENVIRONMENT_MAX_TOTAL_VALUE_BYTES,
  DXD_ENVIRONMENT_MAX_VALUE_BYTES,
  type DxdEnvironmentActivateOperation,
  DxdEnvironmentActivateOperation as DxdEnvironmentActivateOperationSchema,
} from "../../execution/dxd/protocol.js";
import type { ExecutionEnvironmentSnapshot } from "./execution.js";

export const MAX_EFFECTIVE_ENVIRONMENT_ENTRIES = DXD_ENVIRONMENT_MAX_ENTRIES;
export const MAX_EFFECTIVE_ENVIRONMENT_VALUE_BYTES =
  DXD_ENVIRONMENT_MAX_VALUE_BYTES;
export const MAX_EFFECTIVE_ENVIRONMENT_TOTAL_BYTES =
  DXD_ENVIRONMENT_MAX_TOTAL_VALUE_BYTES;

/**
 * Names a daemon before `DXD_CURRENT_ENVIRONMENT_RELEASE` rejects, which
 * fails its whole activation: the reserved list before October 2026. Remove
 * once every supported dxd release is at least that release.
 */
const earlierDaemonReservedNames = new Set([
  "BASHPID",
  "BASHOPTS",
  "BASH_ENV",
  "BASH_VERSION",
  "BASH_VERSINFO",
  "BETTER_AUTH_SECRET",
  "CI",
  "COLUMNS",
  "DX_ACCESS_AUDIENCE",
  "DX_ACCESS_ISSUER",
  "DX_AUTH_TRUSTED_ORIGINS",
  "DX_AUTH_URL",
  "DX_CONFIG_ENCRYPTION_KEYS",
  "DX_E2B_TEMPLATE",
  "DX_E2B_TIMEOUT_MS",
  "DX_ENV",
  "DX_EXPERIMENTAL_FEATURE_FIXTURE",
  "DX_INTEGRATION_FORGEJO_OAUTH",
  "DX_INTEGRATION_GITHUB_APP",
  "DX_INTEGRATION_GITLAB_OAUTH",
  "DX_MANAGED_SSH_SIGNING_ENABLED",
  "DX_MODEL_DEPLOYMENT_PROVIDERS",
  "DX_MODEL_ENDPOINT_ALLOWLIST",
  "DX_RUNNER_PROFILE_CATALOG",
  "DX_STORAGE",
  "DX_WORKLOAD_IDENTITY_SOCKET",
  "ENV",
  "E2B_API_KEY",
  "EUID",
  "HISTFILE",
  "HISTFILESIZE",
  "HISTSIZE",
  "HOME",
  "HOSTNAME",
  "IFS",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LINES",
  "LOGNAME",
  "NODE_OPTIONS",
  "PATH",
  "PPID",
  "PWD",
  "SHELL",
  "SHELLOPTS",
  "SHLVL",
  "TERM",
  "TMUX",
  "TMUX_PANE",
  "UID",
  "USER",
  "_",
]);

const acceptedByEarlierDaemon = (name: string) =>
  !earlierDaemonReservedNames.has(name) &&
  !name.startsWith("CF_") &&
  !name.startsWith("CLOUDFLARE_") &&
  !name.startsWith("DYLD_");

export const environmentActivationOperation = (
  snapshot: ExecutionEnvironmentSnapshot,
  generation: number,
  git: DxdEnvironmentActivateOperation["git"] = {
    authorName: "dxcodeagent",
    authorEmail: "agent@dxcode.dev",
    threadUrl:
      "https://dx.example.test/threads/thr_00000000-0000-4000-8000-000000000000",
    signingEnabled: false,
  },
  /** Whether the daemon is at least `DXD_CURRENT_ENVIRONMENT_RELEASE`. */
  daemon: { readonly current: boolean } = { current: true },
): DxdEnvironmentActivateOperation => {
  const encoder = new TextEncoder();
  let totalBytes = 0;
  const names = new Set<string>();
  const entries = snapshot.values
    .filter(
      ({ name, value }) =>
        !isReservedEnvironmentVariableName(name) &&
        (daemon.current ||
          (acceptedByEarlierDaemon(name) && Redacted.value(value) !== "")),
    )
    .map(({ name, value }) => {
      if (names.has(name)) throw new Error("Duplicate environment variable.");
      names.add(name);
      const bytes = encoder.encode(Redacted.value(value));
      totalBytes += bytes.byteLength;
      if (
        bytes.byteLength > MAX_EFFECTIVE_ENVIRONMENT_VALUE_BYTES ||
        totalBytes > MAX_EFFECTIVE_ENVIRONMENT_TOTAL_BYTES
      )
        throw new Error("Environment snapshot exceeds its bounds.");
      return { name, valueBase64Url: encodeBase64Url(bytes) };
    });
  if (entries.length > MAX_EFFECTIVE_ENVIRONMENT_ENTRIES)
    throw new Error("Environment snapshot exceeds its bounds.");
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return Schema.decodeUnknownSync(DxdEnvironmentActivateOperationSchema)(
    { operation: "environment.activate", generation, entries, git },
    { onExcessProperty: "error" },
  );
};
