import type { SandboxFactory } from "@flue/runtime";
import { environmentMaskerOf } from "../../settings/environment-variables/sandbox.js";
import { insertPluginAudit, type PluginAuditOutcome } from "../audit/audit.js";
import type { PluginInstallRecord } from "./host.js";

/**
 * Plugin code's shell commands (`ctx.$` and `ctx.exec`, from the manifest's
 * `permissions.shell`). Each command runs in the Thread's Orb through the
 * same sandbox the Thread's own commands use, so it keeps the Thread's
 * authorization, Orb activity, environment, and Changes refresh, and its
 * output is masked like a shell read. Before it runs, the Thread's other
 * plugins' `tool.call` handlers see it as a `shell_command` call and may
 * reject, modify, or answer it. Every command, run or refused, writes one
 * `shell.exec` audit row.
 */

type Sandbox = Awaited<ReturnType<SandboxFactory["createSandbox"]>>;

/** How long a command runs when the plugin does not say. */
export const SHELL_DEFAULT_TIMEOUT_MS = 30_000;
/** The longest a command runs; the call's own time limit still applies. */
export const SHELL_MAX_TIMEOUT_MS = 60_000;
/** stdout and stderr each keep at most their first this many bytes. */
export const SHELL_OUTPUT_BYTES = 131_072;
/**
 * A stream cut at the limit drops at most this much more of its end, so a
 * secret the cut split in half never shows.
 */
export const SHELL_CUT_MARGIN_BYTES = 16_384;
/** A command line is at most this long. */
export const SHELL_COMMAND_BYTES = 16_384;
/** One plugin call runs at most this many commands. */
export const SHELL_RUNS_PER_CALL = 32;
/** One plugin call runs at most this many commands at once. */
export const SHELL_CONCURRENT_PER_CALL = 4;
/** What the guest gets beyond the command's own limit to start and report. */
const GUEST_SLACK_MS = 15_000;

export interface PluginShellRequest {
  readonly command: string;
  /** A folder inside the Thread's checkout, relative to it. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface PluginShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The command ran out of time and dx stopped it (exit code 124). */
  readonly timedOut: boolean;
  /** stdout or stderr was longer than dx keeps. */
  readonly truncated: boolean;
}

/** What the Thread's `tool.call` handlers decided about one command. */
export type PluginShellDecision =
  | {
      readonly kind: "allow";
      readonly input: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "reject"; readonly message: string }
  | { readonly kind: "synthesize"; readonly output: unknown };

/**
 * Asks the Thread's other plugins about one command before it runs.
 * `workdir` is absolute, as in the agent's own `shell_command`; the
 * workspace is the Thread's, already open.
 */
export type PluginShellGate = (
  input: { readonly command: string; readonly workdir: string },
  workspace: Sandbox,
) => Promise<PluginShellDecision>;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A refusal the plugin hears as a rejected promise. */
export class PluginShellRefused extends Error {
  override readonly name = "PluginShellRefused";
}

/** `cwd` as a clean path inside the checkout, or "." for the checkout. */
export const shellWorkdirOf = (cwd: unknown): string => {
  if (cwd === undefined || cwd === null || cwd === "" || cwd === ".")
    return ".";
  if (typeof cwd !== "string" || cwd.length > 512)
    throw new PluginShellRefused(
      "cwd is a folder inside the Thread's checkout, at most 512 characters.",
    );
  const parts = cwd.split("/").filter((part) => part !== "" && part !== ".");
  if (cwd.startsWith("/") || cwd.startsWith("~") || parts.includes(".."))
    throw new PluginShellRefused(
      "cwd is relative to the Thread's checkout and stays inside it: no leading /, ~, or ..",
    );
  if (parts.some((part) => /[\0\n\r]/.test(part)))
    throw new PluginShellRefused("cwd holds a character dx does not allow.");
  return parts.length === 0 ? "." : parts.join("/");
};

export const shellTimeoutOf = (value: unknown): number => {
  if (value === undefined || value === null) return SHELL_DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1_000)
    throw new PluginShellRefused(
      `timeoutMs is a number of milliseconds from 1,000 to ${SHELL_MAX_TIMEOUT_MS.toLocaleString("en-US")}.`,
    );
  return Math.min(Math.floor(value), SHELL_MAX_TIMEOUT_MS);
};

export const shellCommandOf = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "")
    throw new PluginShellRefused("A command is non-empty text.");
  if (new TextEncoder().encode(value).byteLength > SHELL_COMMAND_BYTES)
    throw new PluginShellRefused(
      `A command is at most ${SHELL_COMMAND_BYTES.toLocaleString("en-US")} bytes.`,
    );
  if (value.includes("\0"))
    throw new PluginShellRefused("A command holds no NUL characters.");
  return value;
};

/** A folder the gate named: absolute inside the checkout, or relative. */
export const gateWorkdirOf = (checkout: string, value: unknown): string => {
  if (typeof value === "string" && value.startsWith("/")) {
    const root = checkout.replace(/\/+$/, "");
    if (value === root) return ".";
    if (value.startsWith(`${root}/`))
      return shellWorkdirOf(value.slice(root.length + 1));
  }
  return shellWorkdirOf(value);
};

/** Where the guest keeps each running command's process group. */
const STATE = '"$HOME/.local/state/dx-plugin-shell"';

/**
 * The guest side. The command runs in its own process group under
 * `timeout` (TERM, then KILL two seconds later) with no stdin. Each stream
 * goes through a FIFO whose reader keeps only the first
 * {@link SHELL_OUTPUT_BYTES} + 1 bytes and drains the rest, so a flood
 * never reaches the disk. When the command ends, whatever it left running
 * in its group is killed. dx reads back a marked status line and the kept
 * bytes in hex, a space before each byte, so a login profile's output or
 * binary output cannot confuse the reply, and the Thread sandbox's secret
 * masking, which also matches a secret's base64 forms, never rewrites it:
 * dx masks the decoded text instead.
 */
export const shellGuestScript = (
  command: string,
  directory: string,
  timeoutMs: number,
  runId: string,
) => `set +e
state=${STATE}
mkdir -p "$state" && chmod 700 "$state"
d=$(mktemp -d) || exit 90
trap 'rm -rf -- "$d" "$state/${runId}" "$state/${runId}.stop"' EXIT
# A stop that came after its command had already finished.
find "$state" -name '*.stop' -mmin +10 -delete 2>/dev/null
: >"$d/o"; : >"$d/e"
mkfifo "$d/op" "$d/ep" || exit 91
# Readers in their own groups, so a child that left the command's group
# and still holds a pipe cannot keep the reply waiting.
set -m
{ dd of="$d/o" bs=1 count=${SHELL_OUTPUT_BYTES + 1} status=none; cat >/dev/null; } <"$d/op" &
ro=$!
{ dd of="$d/e" bs=1 count=${SHELL_OUTPUT_BYTES + 1} status=none; cat >/dev/null; } <"$d/ep" &
re=$!
set +m
started=$(date +%s%3N)
if cd -- ${quote(directory)} 2>/dev/null; then
  set -m
  timeout -k 2s ${Math.ceil(timeoutMs / 1_000)}s bash -c ${quote(command)} </dev/null >"$d/op" 2>"$d/ep" &
  job=$!
  set +m
  printf '%s' "$job" >"$state/${runId}"
  # The call may have ended while the command started.
  [[ -e "$state/${runId}.stop" ]] && kill -TERM -- "-$job" 2>/dev/null
  wait "$job"
  code=$?
  kill -KILL -- "-$job" 2>/dev/null
else
  printf '%s\\n' ${quote(`No folder ${directory} in the Thread's Orb.`)} >"$d/ep"
  : >"$d/op"
  code=1
fi
for _ in {1..20}; do
  kill -0 "$ro" 2>/dev/null || kill -0 "$re" 2>/dev/null || break
  sleep 0.1
done
kill -KILL -- "-$ro" "-$re" 2>/dev/null
wait "$ro" "$re" 2>/dev/null
ms=$(( $(date +%s%3N) - started ))
timed=0
if [[ ( $code == 124 || $code == 137 ) && $ms -ge ${Math.ceil(timeoutMs / 1_000) * 1_000} ]]; then timed=1; fi
printf '\\nDXSHELL2 %s %s %s %s\\n' "$code" "$(stat -c %s "$d/o")" "$(stat -c %s "$d/e")" "$timed"
head -c ${SHELL_OUTPUT_BYTES} "$d/o" | od -An -v -tx1 | tr '\\n' ' '; printf '\\n'
head -c ${SHELL_OUTPUT_BYTES} "$d/e" | od -An -v -tx1 | tr '\\n' ' '; printf '\\n'
`;

/** Ends a command a finished plugin call left running, and its group. */
export const shellStopScript = (runId: string) => `f=${STATE}/${runId}
mkdir -p ${STATE}
# A command still starting finds this and stops itself.
: >"$f.stop"
[[ -s "$f" ]] || exit 0
p=$(cat "$f")
kill -TERM -- "-$p" 2>/dev/null
sleep 1
[[ -e "$f" ]] && kill -KILL -- "-$p" 2>/dev/null
exit 0
`;

/** Text from `od -tx1` hex, a space before each byte. */
const decodeHex = (text: string) => {
  const pairs = text.trim() === "" ? [] : text.trim().split(/\s+/);
  const bytes = new Uint8Array(pairs.length);
  for (const [index, pair] of pairs.entries()) {
    const byte = Number.parseInt(pair, 16);
    if (!/^[0-9a-f]{2}$/.test(pair) || Number.isNaN(byte))
      throw new Error("The Orb's reply was not hex.");
    bytes[index] = byte;
  }
  return new TextDecoder().decode(bytes);
};

/** Reads the guest's reply; undefined when it has no status line. */
export const parseShellReply = (stdout: string) => {
  const lines = stdout.split("\n");
  const at = lines.findLastIndex((line) => line.startsWith("DXSHELL2 "));
  if (at < 0) return undefined;
  const [, code, outBytes, errBytes, timed] = lines[at]?.split(" ") ?? [];
  const exitCode = Number(code);
  if (!Number.isInteger(exitCode)) return undefined;
  return {
    exitCode,
    stdout: decodeHex(lines[at + 1] ?? ""),
    stderr: decodeHex(lines[at + 2] ?? ""),
    timedOut: timed === "1",
    stdoutTruncated: Number(outBytes) > SHELL_OUTPUT_BYTES,
    stderrTruncated: Number(errBytes) > SHELL_OUTPUT_BYTES,
  };
};

/**
 * The program a command starts with, for the audit; never its arguments,
 * and nothing that looks like an assignment.
 */
export const shellProgramOf = (command: string) => {
  const program =
    /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([^\s;&|()<>]+)/.exec(
      command,
    )?.[1] ?? "";
  // Anything else may be a fragment of a quoted value.
  return /^[A-Za-z0-9_./+-]{1,64}$/.test(program) ? program : "";
};

const sha256Hex = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** Opens the Thread's existing workspace, waking its Orb when it sleeps. */
export const openThreadWorkspace = async (
  threadId: string,
): Promise<Sandbox> => {
  // Loaded on first use: it composes every Orb provider.
  const { ExecutionWorkspaces } = await import(
    "../../execution/execution-workspaces.js"
  );
  return ExecutionWorkspaces.existingSandboxFactory.createSandbox({
    id: threadId,
  });
};

export interface PluginShellRunner {
  run(request: unknown): Promise<PluginShellResult>;
  /** Ends every command still running, when the call ends. */
  stop(): void;
}

/** A call writes at most this many audit rows for refused commands. */
const REFUSALS_AUDITED = 5;

/**
 * One plugin call's commands: at most {@link SHELL_RUNS_PER_CALL}, at most
 * {@link SHELL_CONCURRENT_PER_CALL} at once, sharing one opened workspace.
 */
export const pluginShellRunner = (input: {
  readonly db: D1Database;
  readonly install: PluginInstallRecord;
  readonly threadId: string;
  readonly ownerUserId: string;
  /** The member whose click started the call, for the audit. */
  readonly actorUserId?: string;
  readonly gate: PluginShellGate;
  readonly isOpen: () => boolean;
  /** Tests replace the Orb. */
  readonly openWorkspace?: (threadId: string) => Promise<Sandbox>;
}): PluginShellRunner => {
  let started = 0;
  let running = 0;
  let refusals = 0;
  let workspace: Promise<Sandbox> | undefined;
  /** Set once the call ends: nothing more starts. */
  let stopped = false;
  /** Commands in the guest now, by run ID. */
  const inFlight = new Set<string>();
  const open = input.openWorkspace ?? openThreadWorkspace;
  const audit = (
    outcome: PluginAuditOutcome,
    detail: Readonly<Record<string, unknown>>,
  ) => {
    if (outcome === "rejected" && ++refusals > REFUSALS_AUDITED)
      return Promise.resolve();
    return insertPluginAudit(input.db, {
      ...(input.actorUserId === undefined
        ? {}
        : { actorUserId: input.actorUserId }),
      pluginId: input.install.pluginId,
      pluginName: input.install.name,
      pluginVersion: input.install.version,
      scope: input.install.scope,
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      action: "shell.exec",
      target: input.threadId,
      outcome,
      detail,
    });
  };
  const sandboxOf = async () => {
    try {
      workspace ??= open(input.threadId);
      return await workspace;
    } catch (cause) {
      workspace = undefined;
      throw new Error(
        `dx could not reach this Thread's Orb to run the command (${cause instanceof Error ? cause.message : String(cause)}).`,
      );
    }
  };
  return {
    stop() {
      stopped = true;
      if (inFlight.size === 0 || workspace === undefined) return;
      const ids = [...inFlight];
      inFlight.clear();
      void workspace
        .then((sandbox) =>
          Promise.all(
            ids.map((id) =>
              sandbox.exec(`bash -c ${quote(shellStopScript(id))}`, {
                timeoutMs: 15_000,
              }),
            ),
          ),
        )
        .catch(() => undefined);
    },
    async run(raw) {
      const request = (
        typeof raw === "object" && raw !== null ? raw : {}
      ) as Record<string, unknown>;
      const began = Date.now();
      let command = typeof request.command === "string" ? request.command : "";
      let workdir = ".";
      let timeoutMs = SHELL_DEFAULT_TIMEOUT_MS;
      let audited = false;
      const described = async () => ({
        program: shellProgramOf(command),
        commandSha256: await sha256Hex(command),
        cwd: workdir.slice(0, 200),
        timeoutMs,
      });
      started += 1;
      let counted = false;
      try {
        command = shellCommandOf(request.command);
        workdir = shellWorkdirOf(request.cwd);
        timeoutMs = shellTimeoutOf(request.timeoutMs);
        if (started > SHELL_RUNS_PER_CALL)
          throw new PluginShellRefused(
            `A plugin call runs at most ${SHELL_RUNS_PER_CALL} commands.`,
          );
        if (running >= SHELL_CONCURRENT_PER_CALL)
          throw new PluginShellRefused(
            `A plugin call runs at most ${SHELL_CONCURRENT_PER_CALL} commands at once; await one before starting another.`,
          );
        running += 1;
        counted = true;
        const sandbox = await sandboxOf();
        const checkout = sandbox.cwd.replace(/\/+$/, "");
        const absolute = (folder: string) =>
          folder === "." ? checkout : `${checkout}/${folder}`;
        const decision = await input.gate(
          { command, workdir: absolute(workdir) },
          sandbox,
        );
        if (decision.kind === "reject") {
          audited = true;
          // The handler's message may quote the command, so it stays out.
          await audit("rejected", {
            ...(await described()),
            by: "tool.call",
          });
          throw new PluginShellRefused(decision.message);
        }
        if (decision.kind === "synthesize") {
          await audit("success", {
            ...(await described()),
            synthesized: true,
            ms: Date.now() - began,
          });
          const output = decision.output;
          return {
            exitCode: 0,
            stdout:
              typeof output === "string"
                ? output
                : JSON.stringify(output ?? null),
            stderr: "",
            timedOut: false,
            truncated: false,
          };
        }
        // A handler's modify may change the command or its folder.
        if (decision.input.command !== undefined)
          command = shellCommandOf(decision.input.command);
        if (decision.input.workdir !== undefined)
          workdir = gateWorkdirOf(checkout, decision.input.workdir);
        if (stopped || !input.isOpen())
          throw new PluginShellRefused(
            "This plugin call has ended; dx no longer serves it.",
          );
        const runId = `run-${crypto.randomUUID()}`;
        inFlight.add(runId);
        let reply: Awaited<ReturnType<Sandbox["exec"]>>;
        try {
          reply = await sandbox.exec(
            `bash -c ${quote(
              shellGuestScript(command, absolute(workdir), timeoutMs, runId),
            )}`,
            { timeoutMs: timeoutMs + GUEST_SLACK_MS },
          );
        } catch (cause) {
          throw new Error(
            `The Orb did not run the command (${cause instanceof Error ? cause.message : String(cause)}).`,
          );
        } finally {
          inFlight.delete(runId);
        }
        const parsed = parseShellReply(reply.stdout);
        if (parsed === undefined)
          throw new Error(
            `The Orb did not report the command's result (exit ${String(reply.exitCode)}).`,
          );
        const masker = await environmentMaskerOf(sandbox);
        // A stream cut at the limit may end inside a secret, which the
        // masker cannot recognise by half; its last bytes are dropped.
        const masked = (text: string, truncated: boolean) =>
          masker.mask(
            truncated
              ? text.slice(
                  0,
                  Math.max(
                    0,
                    text.length -
                      Math.min(masker.readContextBytes, SHELL_CUT_MARGIN_BYTES),
                  ),
                )
              : text,
          );
        const result: PluginShellResult = {
          exitCode: parsed.exitCode,
          stdout: masked(parsed.stdout, parsed.stdoutTruncated),
          stderr: masked(parsed.stderr, parsed.stderrTruncated),
          timedOut: parsed.timedOut,
          truncated: parsed.stdoutTruncated || parsed.stderrTruncated,
        };
        await audit("success", {
          ...(await described()),
          exitCode: result.exitCode,
          ms: Date.now() - began,
          timedOut: result.timedOut,
          truncated: result.truncated,
        });
        return result;
      } catch (error) {
        if (!audited)
          await audit(
            error instanceof PluginShellRefused ? "rejected" : "failed",
            {
              ...(await described()),
              ms: Date.now() - began,
              // dx's own words, never the command's output.
              reason: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 300),
            },
          );
        throw error;
      } finally {
        if (counted) running -= 1;
      }
    },
  };
};
