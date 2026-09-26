import { AsyncLocalStorage } from "node:async_hooks";
import type {
  SourceOperationRequestType,
  SourceWorkspaceRecord,
} from "@dx/domain";
import type { Sandbox, SandboxFactory } from "@flue/runtime";
import {
  GITHUB_CONFIG_DIRECTORY,
  githubCommandEnvironment,
} from "../../source-control/github/runtime-adapter.js";

export type SourceCommandClassification =
  | { readonly kind: "none" }
  | { readonly kind: "denied"; readonly reason: string }
  | {
      readonly kind: "read";
      readonly request: SourceOperationRequestType;
    };

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

const unsafeShell = /[\n\r;&|`$()<>\\]/;

const words = (command: string): ReadonlyArray<string> | undefined => {
  const trimmed = command.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 2_048 ||
    unsafeShell.test(trimmed)
  )
    return undefined;
  const values = trimmed.split(/\s+/);
  return values.every((value) => /^[A-Za-z0-9_./:@=,+-]+$/.test(value))
    ? values
    : undefined;
};

const forbiddenRepositorySelection = (values: ReadonlyArray<string>) =>
  values.some(
    (value, index) =>
      value === "-R" ||
      value === "--repo" ||
      value.startsWith("--repo=") ||
      ((values[index - 1] === "-R" || values[index - 1] === "--repo") &&
        value !== undefined),
  );

const read = (
  operation: SourceOperationRequestType["operation"],
): SourceCommandClassification => ({
  kind: "read",
  request: { operation, invocationSource: "agent-command" },
});

const isPositiveInteger = (value: string | undefined) =>
  value !== undefined && /^[1-9]\d*$/.test(value);

const exactGhRead = (
  values: ReadonlyArray<string>,
): SourceCommandClassification | undefined => {
  const group = values[1];
  const action = values[2];
  const argument = values[3];
  if (group === "repo" && values.length <= 3 && action === "view")
    return read("repository-read");
  if (group === "pr") {
    if (
      ((action === "list" || action === "status") && values.length === 3) ||
      ((action === "view" || action === "checks") &&
        values.length === 4 &&
        isPositiveInteger(argument))
    )
      return read(
        action === "checks" ? "checks-status-read" : "pull-request-read",
      );
  }
  if (group === "issue") {
    if (
      ((action === "list" || action === "status") && values.length === 3) ||
      (action === "view" && values.length === 4 && isPositiveInteger(argument))
    )
      return read("issue-read");
  }
  if (group === "run") {
    if (
      (action === "list" && values.length === 3) ||
      ((action === "view" || action === "watch") &&
        values.length === 4 &&
        isPositiveInteger(argument))
    )
      return read("actions-read");
  }
  if (group === "workflow") {
    if (
      (action === "list" && values.length === 3) ||
      (action === "view" &&
        values.length === 4 &&
        argument !== undefined &&
        /^[A-Za-z0-9_.-]+$/.test(argument))
    )
      return read("actions-read");
  }
  return undefined;
};

const gitWords = (command: string) => {
  const values = words(command);
  if (values?.[0] === "git") return values;
  return values?.[0] === "command" && values[1] === "git"
    ? values.slice(1)
    : undefined;
};

export const classifySourceCommand = (
  command: string,
): SourceCommandClassification => {
  // Git owns its command language. Git's configured signing and credential
  // helpers are its only DX integration points; Bash admission never parses
  // or replaces a Git invocation.
  if (/^\s*(?:command\s+)?git(?:\s|$)/.test(command)) return { kind: "none" };
  const git = gitWords(command);
  if (git !== undefined) {
    if (git.some((value) => value.includes("://") || value.startsWith("git@")))
      return { kind: "denied", reason: "arbitrary-repository" };
    return ["fetch", "pull", "push", "ls-remote"].includes(git[1] ?? "")
      ? read("contents-push")
      : { kind: "none" };
  }
  const values = words(command);
  if (values === undefined) {
    return /(^|\s)(git|gh)(\s|$)/.test(command)
      ? { kind: "denied", reason: "ambiguous-command" }
      : { kind: "none" };
  }
  if (values[0] !== "gh") return { kind: "none" };
  if (values.some((value) => value.includes("://")))
    return { kind: "denied", reason: "arbitrary-repository" };
  if (
    values.some(
      (value) => value === "--hostname" || value.startsWith("--hostname="),
    ) &&
    values[1] !== "auth"
  )
    return { kind: "denied", reason: "arbitrary-host" };
  if (forbiddenRepositorySelection(values))
    return { kind: "denied", reason: "arbitrary-repository" };
  const group = values[1];
  const action = values[2];
  if (group === "api") return { kind: "denied", reason: "raw-api-disabled" };
  if (group === "auth") {
    if (action === "login" || action === "setup-git")
      return { kind: "denied", reason: "persistent-auth-disabled" };
    const permitted =
      values.length === 3 ||
      (values.length === 4 && values[3] === "--hostname=github.com") ||
      (values.length === 5 &&
        values[3] === "--hostname" &&
        values[4] === "github.com");
    return action === "status" && permitted
      ? read("provider-auth-read")
      : { kind: "denied", reason: "unsupported-auth-command" };
  }
  const boundedRead = exactGhRead(values);
  if (boundedRead !== undefined) return boundedRead;
  if (["repo", "pr", "issue", "run", "workflow"].includes(group ?? ""))
    return { kind: "denied", reason: "use-semantic-source-tool" };
  return { kind: "denied", reason: "unsupported-gh-command" };
};

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

const assertExpectedGitOrigin = async (
  sandbox: Sandbox,
  source: SourceWorkspaceRecord,
  cwd: string,
) => {
  const snapshot = source.snapshot;
  if (snapshot === undefined)
    throw new Error("Source snapshot is unavailable.");
  const environment =
    snapshot.provider === "github"
      ? githubCommandEnvironment("", snapshot.repositoryName)
      : {};
  const result = await sandbox.exec("git remote get-url origin", {
    cwd,
    env: {
      ...protectedUnauthenticatedEnvironment,
      ...environment,
    },
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0 || result.stdout.trim() !== snapshot.cloneUrl)
    throw new Error("Source command denied: repository origin changed.");
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
      // Git is native on every surface. Do this before resolving source
      // authority so local reads and commits stay offline-capable and use the
      // terminal's dxd-owned config/helpers without a model-only environment.
      if (/^\s*(?:command\s+)?git(?:\s|$)/.test(command))
        return sandbox.exec(command, {
          ...options,
          // Agent Bash is not a login shell, so it does not source the
          // terminal profile. Point it at the same dxd-owned configuration;
          // Git still owns all command and transport semantics.
          env: {
            ...options?.env,
            GIT_CONFIG_GLOBAL: "/home/user/.local/state/dx-terminal/gitconfig",
          },
        });
      const source = await resolveSource();
      const trusted = trustedCommand.getStore();
      if (trusted !== undefined && trusted.command !== command)
        throw new Error("Trusted source command changed before execution.");
      if (trusted?.kind === "local")
        return sandbox.exec(command, {
          ...options,
          env: { ...options?.env, ...protectedUnauthenticatedEnvironment },
        });
      const classification =
        trusted === undefined
          ? classifySourceCommand(command)
          : ({ kind: "read", request: trusted.request } as const);
      if (source.snapshot === undefined) {
        if (classification.kind === "denied")
          throw new Error(`Source command denied: ${classification.reason}.`);
        if (classification.kind === "read")
          throw new Error(
            "Source command denied: source authority unavailable.",
          );
        return sandbox.exec(command, {
          ...options,
          env: { ...options?.env, ...protectedUnauthenticatedEnvironment },
        });
      }
      if (
        source.snapshot.provider === "bitbucket" &&
        words(command)?.[0] === "gh"
      )
        throw new Error(
          "Source command denied: unsupported-provider-cli-command.",
        );
      if (classification.kind === "denied")
        throw new Error(`Source command denied: ${classification.reason}.`);
      if (classification.kind === "none")
        return sandbox.exec(command, {
          ...options,
          env: { ...options?.env, ...protectedUnauthenticatedEnvironment },
        });
      const gitCommand = gitWords(command) !== undefined;
      const cwd = options?.cwd ?? sandbox.cwd;
      if (gitCommand) await assertExpectedGitOrigin(sandbox, source, cwd);
      return withLease(source, classification.request, async (lease) => {
        const hardenedLease =
          gitCommand && source.snapshot?.provider === "github"
            ? githubCommandEnvironment(
                lease.GH_TOKEN ?? "",
                source.snapshot?.repositoryName ?? "",
              )
            : lease;
        const secrets = Object.entries(lease)
          .filter(([key, value]) => key.includes("TOKEN") && value.length > 0)
          .map(([, value]) => value);
        let result: Awaited<ReturnType<Sandbox["exec"]>> | undefined;
        let commandFailure: Error | undefined;
        try {
          const unsafeResult = await sandbox.exec(command, {
            ...options,
            cwd,
            env: {
              ...options?.env,
              ...protectedUnauthenticatedEnvironment,
              ...hardenedLease,
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
