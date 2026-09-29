import { AsyncLocalStorage } from "node:async_hooks";
import type {
  SourceOperationRequestType,
  SourceWorkspaceRecord,
} from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import { GITHUB_CONFIG_DIRECTORY } from "../../source-control/github/runtime-adapter.js";
import { DX_GIT_CONFIG_GLOBAL } from "../../source-control/workspace-assets.js";

interface TrustedSourceCommand {
  readonly kind: "source";
  readonly command: string;
  readonly request: SourceOperationRequestType;
}

interface TrustedLocalCommand {
  readonly kind: "local";
  readonly command: string;
}

const trustedCommand = new AsyncLocalStorage<
  TrustedSourceCommand | TrustedLocalCommand
>();

export const executeTrustedLocalCommand = async (
  sandbox: Sandbox,
  command: string,
  options?: Parameters<Sandbox["exec"]>[1],
) => {
  if (trustedCommand.getStore() !== undefined)
    throw new Error("A trusted source command is already active.");
  return trustedCommand.run({ kind: "local", command }, () =>
    sandbox.exec(command, options),
  );
};

export const executeTrustedSourceCommand = async (
  sandbox: Sandbox,
  command: string,
  request: SourceOperationRequestType,
  options?: Parameters<Sandbox["exec"]>[1],
) => {
  if (trustedCommand.getStore() !== undefined)
    throw new Error("A trusted source command is already active.");
  return trustedCommand.run({ kind: "source", command, request }, () =>
    sandbox.exec(command, options),
  );
};

const nativeGitCommand = /^\s*(?:command\s+)?git(?:\s|$)/;

/**
 * Agent Bash runs like the terminal: native Git and the dx `gh` wrapper
 * authenticate through the dxd-owned Git credential helper, so dx neither
 * parses nor replaces commands. Agent Bash is not a login shell and does not
 * source the terminal profile, so it receives the same Git configuration and
 * PATH explicitly, with prompts disabled because it has no interactive user.
 */
export const nativeCommandEnvironment = Object.freeze({
  PATH: "/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: DX_GIT_CONFIG_GLOBAL,
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
});

const protectedUnauthenticatedEnvironment = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
  GH_DEBUG: "",
  GH_HOST: "github.com",
  GH_REPO: "",
  GH_CONFIG_DIR: GITHUB_CONFIG_DIRECTORY,
  GH_PROMPT_DISABLED: "1",
  DX_GIT_ALLOWED_PATH: "",
  DX_SOURCE_PROVIDER: "",
  DX_BITBUCKET_GIT_TOKEN: "",
  DX_BITBUCKET_GIT_ORIGIN: "",
  DX_BITBUCKET_GIT_PATH: "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  SSH_ASKPASS_REQUIRE: "force",
  GIT_SSH: "",
  GIT_SSH_COMMAND: "/bin/false",
  GIT_PROXY_COMMAND: "",
  GIT_EXEC_PATH: "",
  GIT_CONFIG_PARAMETERS: "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  all_proxy: "",
  GIT_TRACE: "",
  GIT_TRACE_PACKET: "",
  GIT_TRACE_PACK_ACCESS: "",
  GIT_TRACE_PERFORMANCE: "",
  GIT_TRACE_SETUP: "",
  GIT_TRACE_SHALLOW: "",
  GIT_TRACE_CURL: "",
  GIT_TRACE_CURL_NO_DATA: "1",
  GIT_TRACE2: "",
  GIT_TRACE2_EVENT: "",
  GIT_TRACE2_PERF: "",
  GIT_TRACE2_BRIEF: "",
  GIT_TRACE2_CONFIG_PARAMS: "",
  GIT_TRACE2_ENV_VARS: "",
  GIT_TRACE2_DST_DEBUG: "",
  GIT_CURL_VERBOSE: "",
  GIT_TRACE_REDACT: "1",
});

const redact = (value: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce(
    (current, secret) => current.replaceAll(secret, "[REDACTED]"),
    value,
  );

const sanitizeFailure = (cause: unknown, secrets: ReadonlyArray<string>) => {
  if (!(cause instanceof Error))
    return new Error("Source command execution failed.");
  const failure = new Error(redact(cause.message, secrets));
  failure.name = cause.name;
  return failure;
};

const assertNoAuthenticationResidue = async (sandbox: Sandbox) => {
  const result = await sandbox.exec(
    String.raw`node -e 'const fs=require("node:fs"),path=require("node:path");const files=["/home/user/.git-credentials","/home/user/.netrc",path.join(${JSON.stringify(GITHUB_CONFIG_DIRECTORY)},"hosts.yml"),path.join(${JSON.stringify(GITHUB_CONFIG_DIRECTORY)},"config.yml"),path.join(process.cwd(),".git/config")];for(const f of files){if(!fs.existsSync(f))continue;if(f.endsWith(".git-credentials")||f.endsWith(".netrc"))process.exit(41);const s=fs.readFileSync(f,"utf8");if(/oauth_token|authorization\s*=|https:\/\/[^/@\s]+@github\.com/i.test(s))process.exit(41)}'`,
    {
      cwd: sandbox.cwd,
      env: protectedUnauthenticatedEnvironment,
      timeoutMs: 5_000,
    },
  );
  if (result.exitCode !== 0)
    throw new Error("GitHub CLI authentication residue was detected.");
};

const decorate = (
  sandbox: Sandbox,
  _threadId: string,
  resolveSource: () => Promise<SourceWorkspaceRecord>,
  withLease: <A>(
    source: SourceWorkspaceRecord,
    request: SourceOperationRequestType,
    callback: (environment: Readonly<Record<string, string>>) => Promise<A>,
  ) => Promise<A>,
): Sandbox => {
  const decorated: Sandbox = {
    ...sandbox,
    exec: async (command, options) => {
      const trusted = trustedCommand.getStore();
      if (trusted !== undefined && trusted.command !== command)
        throw new Error("Trusted source command changed before execution.");
      if (trusted === undefined || nativeGitCommand.test(command))
        return sandbox.exec(command, {
          ...options,
          env: { ...options?.env, ...nativeCommandEnvironment },
        });
      if (trusted.kind === "local")
        return sandbox.exec(command, {
          ...options,
          env: { ...options?.env, ...protectedUnauthenticatedEnvironment },
        });
      // Semantic source tools run their provider CLI calls with an
      // operation-scoped, callback-bounded lease.
      const source = await resolveSource();
      if (source.snapshot === undefined)
        throw new Error("Source command denied: source authority unavailable.");
      return withLease(source, trusted.request, async (lease) => {
        const secrets = Object.entries(lease)
          .filter(([key, value]) => key.includes("TOKEN") && value.length > 0)
          .map(([, value]) => value);
        let result: Awaited<ReturnType<Sandbox["exec"]>> | undefined;
        let commandFailure: Error | undefined;
        try {
          const unsafeResult = await sandbox.exec(command, {
            ...options,
            cwd: options?.cwd ?? sandbox.cwd,
            env: {
              ...options?.env,
              ...protectedUnauthenticatedEnvironment,
              ...lease,
            },
          });
          result = {
            ...unsafeResult,
            stdout: redact(unsafeResult.stdout, secrets),
            stderr: redact(unsafeResult.stderr, secrets),
          };
        } catch (cause) {
          commandFailure = sanitizeFailure(cause, secrets);
        }
        let residueFailure: Error | undefined;
        try {
          await assertNoAuthenticationResidue(sandbox);
        } catch (cause) {
          residueFailure = sanitizeFailure(cause, secrets);
        }
        if (commandFailure !== undefined && residueFailure !== undefined)
          throw new AggregateError(
            [commandFailure, residueFailure],
            "Source command and authentication-residue finalization failed.",
          );
        if (commandFailure !== undefined) throw commandFailure;
        if (residueFailure !== undefined) throw residueFailure;
        if (result === undefined)
          throw new Error("Source command produced no result.");
        return result;
      });
    },
  };
  return decorated;
};

export const withSourceCommandAdmission = (
  factory: SandboxFactory,
  resolveSource: (threadId: string) => Promise<SourceWorkspaceRecord>,
  withLease: <A>(
    threadId: string,
    source: SourceWorkspaceRecord,
    request: SourceOperationRequestType,
    callback: (environment: Readonly<Record<string, string>>) => Promise<A>,
  ) => Promise<A>,
): SandboxFactory => ({
  createSandbox: async ({ id }) =>
    decorate(
      await factory.createSandbox({ id }),
      id,
      () => resolveSource(id),
      (source, request, callback) => withLease(id, source, request, callback),
    ),
  ...(factory.tools === undefined ? {} : { tools: factory.tools }),
});
