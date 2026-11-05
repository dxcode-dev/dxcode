import { Type } from "@earendil-works/pi-ai";
import type { Sandbox, SandboxToolFactory } from "@flue/runtime";
import { getLogger } from "@logtape/logtape";
import { environmentMaskerOf } from "../../../settings/environment-variables/sandbox.js";
import { shellDefinitions } from "./definitions.js";

type AgentTool = ReturnType<SandboxToolFactory>[number];
const logger = getLogger(["dx", "execution", "shell"]);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const MAX_WAIT_MS = 60_000;
const shellWaitMs = (value?: number) =>
  value === undefined || !Number.isFinite(value)
    ? 10_000
    : Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(value)));
/**
 * The start only launches the command and records its pid, so it has its own
 * budget: on an overloaded Orb (#1584) even a login shell takes seconds to
 * spawn, and a start that shared the wait's budget lost the pid.
 */
const START_BUDGET_MS = 30_000;
/** Beyond the wait itself, what the guest gets to spawn and read. */
const WAIT_SLACK_MS = 5_000;

// Each read keeps at most the last 51,200 bytes and 2,000 lines. The cursor
// advances past discarded bytes too. Guest log files themselves are retained.
// The read sends, in hex, the `context` bytes just before what it keeps, so
// Core masks a secret that began there and shows what the read before held
// back, and what it keeps, so Core sees the bytes as written. A space parts
// each byte, so no form of a secret matches the hex itself. Whether a read
// before already reported the command's end says nothing is held back any
// more.
const readScript = (wait: number, context: number) => `
deadline=$(( $(date +%s%3N) + ${wait} ))
while [[ ! -f "$state/exit" && $(date +%s%3N) -lt $deadline ]]; do sleep 0.1; done
# Serialize readers so concurrent calls cannot return the same bytes. A
# reader killed without its EXIT trap (SIGKILL after a deadline) leaves the
# lock behind; one older than a minute is stale.
while ! mkdir "$state/read-lock" 2>/dev/null; do
  if [[ -n $(find "$state/read-lock" -maxdepth 0 -mmin +1 2>/dev/null) ]]; then rmdir "$state/read-lock" 2>/dev/null; fi
  sleep 0.1
done
trap 'rmdir "$state/read-lock"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
cursor=$(cat "$state/cursor")
running=true; code=
if [[ -f "$state/exit" ]]; then running=false; code=$(cat "$state/exit"); fi
size=$(stat -c %s "$state/output")
start=$cursor
(( size - start > 51200 )) && start=$((size - 51200))
dd if="$state/output" bs=1 skip="$start" count="$((size-start))" status=none | tail -n 2000 > "$state/read"
kept=$(stat -c %s "$state/read")
truncated=0
(( kept < size - cursor )) && truncated=1
from=$((size - kept)); before=$(( from < ${context} ? from : ${context} ))
flushed=0
[[ -f "$state/flushed" ]] && flushed=1
[[ $running == false ]] && : > "$state/flushed"
printf '%s' "$size" > "$state/cursor"
printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "$pid" "$running" "$code" "$truncated" "$flushed"
(( before > 0 )) && tail -c +"$((from - before + 1))" "$state/output" | head -c "$before" | od -An -v -tx1 | tr '\\n' ' '
printf '\\n'
od -An -v -tx1 "$state/read" | tr '\\n' ' '
printf '\\n'
`;

// A Stop that wrote `$state/stop` before this check finds no pid, or finds
// this pid and kills its group; either way the command never outlives it.
const runner = `state="$1"
# Written whole, so a start that sees the file never reads it empty.
printf '%s' "$$" > "$state/pid.tmp"; mv "$state/pid.tmp" "$state/pid"
finish() { printf '%s' "$1" > "$state/exit.tmp"; mv "$state/exit.tmp" "$state/exit"; }
trap 'finish 143; exit 143' TERM
trap 'finish 129; exit 129' HUP
[[ -f "$state/stop" ]] && { finish 143; exit 143; }
bash "$state/command" > "$state/output" 2>&1 &
wait $!
finish $?
`;

// SIGTERM to the group, then SIGKILL after a second, as shell_command_kill.
const killGroup = `
if [[ ! -f "$state/exit" ]]; then
  kill -TERM -- "-$pid" 2>/dev/null || true
  sleep 1
  if kill -0 -- "-$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  # SIGKILL cannot run the runner's exit trap.
  if [[ ! -f "$state/exit" ]]; then echo 137 > "$state/exit"; fi
fi
`;

// Stop during shell_command ends the command it started. Claiming the state
// directory first keeps a start that has not reached the guest from running.
const stopScript = (state: string) => `umask 077
root="$HOME/.local/state/dx-shell"
state="$root/${state}"
mkdir -p "$root"
mkdir "$state" 2>/dev/null && exit 0
: > "$state/stop"
deadline=$(( $(date +%s%3N) + 5000 ))
while [[ ! -f "$state/pid" && $(date +%s%3N) -lt $deadline ]]; do sleep 0.05; done
[[ -f "$state/pid" ]] || exit 0
pid=$(cat "$state/pid")
${killGroup}`;

/** Output a read sent as hex, a space before each byte. */
const bytesOfHex = (hex: string) => Buffer.from(hex.replaceAll(" ", ""), "hex");

const stoppedError = (signal: AbortSignal) => {
  const error = new DOMException(
    "Stopped with the turn. dx ends the command and its child processes with SIGTERM, then SIGKILL after one second.",
    "AbortError",
  );
  Object.defineProperty(error, "cause", {
    value: signal.reason,
    configurable: true,
  });
  return error;
};

/** A write failed because the Orb's filesystem has no room left. */
const DISK_FULL = /No space left on device|ENOSPC|Disk quota exceeded/i;
/** The direct run's output kept, as the background runner's tail. */
const DIRECT_OUTPUT_BYTES = 50 * 1024;

/**
 * shell_command on a disk too full for its state (#1649): btrfs metadata
 * runs out, every new file fails, yet reading, `du`, and `rm` still work.
 * The command runs directly, in the foreground, bounded by the wait, with
 * no state files, through the same sandbox, so the same authorization and
 * output redaction apply. The agent hears why, and that background commands
 * and shell_command_status come back once space is freed.
 */
const runDirect = async (
  guestExec: (
    script: string,
    timeoutMs: number,
  ) => Promise<Awaited<ReturnType<Sandbox["exec"]>>>,
  cwd: string,
  command: string,
  wait: number,
  note: string | undefined,
) => {
  const result = await guestExec(
    `cd -- ${quote(cwd)} || exit 1\n${command}`,
    wait,
  );
  const combined = `${result.stdout}${result.stderr}`;
  const output =
    combined.length > DIRECT_OUTPUT_BYTES
      ? `[Output truncated to the last 50 KB]\n${combined.slice(-DIRECT_OUTPUT_BYTES)}`
      : combined;
  const exitCode = result.exitCode ?? 0;
  const lines = [
    `<output>${output}</output>`,
    `<exitCode>${String(exitCode)}</exitCode>`,
    "<note>The Orb's disk is full: dx could not write the state a background command needs, so it ran this one directly and waited for it. Commands that create files fail until space is freed; reading, du, and rm still work. Find what fills the disk (du -xh -d 2 ~ 2>/dev/null | sort -h | tail -n 20). Delete only caches and build output that a command can rebuild (node_modules, target, dist, .cache, package-manager caches); for anything else, even a file that looks like junk, tell the person what it is and its size and ask before deleting it. Background commands and shell_command_status work again once there is room.</note>",
    ...(note === undefined ? [] : [`<note>${note}</note>`]),
  ];
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { pid: 0, running: false, exitCode },
  };
};

export const createShellTools = (
  sandbox: Sandbox,
  options?: { defaultWorkdir?: string },
): AgentTool[] =>
  shellDefinitions.map((definition, index) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: Type.Unsafe<{
      command: string;
      workdir?: string;
      timeout_ms?: number;
      pid: number;
    }>(definition.parameters),
    async execute(_toolCallId, input, signal) {
      const params = input as {
        command: string;
        workdir?: string;
        timeout_ms?: number;
        pid: number;
      };
      signal?.throwIfAborted();
      const wait = index === 2 ? 2000 : shellWaitMs(params.timeout_ms);
      // An out-of-range wait is clamped, and the agent hears so.
      const note =
        index !== 2 &&
        typeof params.timeout_ms === "number" &&
        Number.isFinite(params.timeout_ms) &&
        params.timeout_ms > MAX_WAIT_MS
          ? `timeout_ms ${params.timeout_ms} is above the ${MAX_WAIT_MS} maximum, so dx waited ${MAX_WAIT_MS} ms. The command keeps running after the wait; follow it with shell_command_status.`
          : undefined;
      const prefix = `umask 077\nroot="$HOME/.local/state/dx-shell"\n`;
      // Core names the start directory so Stop can find it before the pid.
      const startState = `start.${crypto.randomUUID()}`;
      // Listening before Flue does (execute runs before Flue's abort race
      // subscribes) settles this call with the error below, not Flue's
      // "may still be running".
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal?.reason);
      });
      aborted.catch(() => undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      const guestExec = (script: string, timeoutMs: number) =>
        Promise.race([
          sandbox.exec(`bash -c ${quote(script)}`, { timeoutMs, signal }),
          aborted,
        ]);
      // Stop ends a command the agent is still waiting on. One it already
      // left running, and now follows with shell_command_status, keeps
      // running. Flue abandons this call on abort, so the stop runs on.
      const stopStarted = () => {
        void sandbox
          .exec(`bash -c ${quote(stopScript(startState))}`, {
            timeoutMs: 15_000,
          })
          .then(
            (stopped) => {
              if (stopped.exitCode !== 0)
                logger.warn("Stopping a shell command failed", {
                  exitCode: stopped.exitCode,
                  stderr: stopped.stderr,
                });
            },
            (cause: unknown) =>
              logger.warn("Stopping a shell command failed", {
                error: String(cause),
              }),
          );
      };
      let pid: number;
      let context: number;
      let result: Awaited<ReturnType<Sandbox["exec"]>> | undefined;
      try {
        if (index === 0) {
          const cwd = params.workdir ?? options?.defaultWorkdir ?? sandbox.cwd;
          // The start only launches the command and returns its pid.
          const started = await guestExec(
            `${prefix}
[[ -d ${quote(cwd)} ]] || { echo 'Working directory does not exist:' ${quote(cwd)} >&2; exit 1; }
cd -- ${quote(cwd)} || exit 1
mkdir -p "$root"
state="$root/${startState}"
mkdir "$state" 2>/dev/null || { echo 'Stopped before the command started.' >&2; exit 1; }
printf '%s' ${quote(params.command)} > "$state/command"
printf '%s' ${quote(runner)} > "$state/runner"
: > "$state/output"; echo 0 > "$state/cursor"
nohup setsid bash "$state/runner" "$state" </dev/null >/dev/null 2>&1 &
while [[ ! -f "$state/pid" ]]; do sleep 0.01; done
pid=$(cat "$state/pid")
# The runner keeps its initial path; the public pid path is a durable alias.
ln -s "$state" "$root/$pid" || exit 1
printf '%s' "$pid"`,
            START_BUDGET_MS,
          ).catch((cause: unknown) => {
            if (signal?.aborted === true) throw cause;
            // It may still start once the Orb catches up; never leave a
            // command running that the agent was told failed.
            stopStarted();
            throw new Error(
              `The Orb took more than ${START_BUDGET_MS / 1000} s to start the command, so dx stopped it. The Orb is likely overloaded: check heavy background processes before retrying. (${cause instanceof Error ? cause.message : String(cause)})`,
            );
          });
          signal?.throwIfAborted();
          if (
            started.exitCode !== 0 &&
            DISK_FULL.test(`${started.stderr}\n${started.stdout}`)
          )
            return await runDirect(guestExec, cwd, params.command, wait, note);
          if (started.exitCode !== 0)
            throw new Error(
              started.stderr ||
                started.stdout ||
                "Shell process operation failed",
            );
          // The pid is the start's last line; a login profile may print first.
          pid = Number(started.stdout.trim().split("\n").at(-1));
          if (!Number.isSafeInteger(pid) || pid <= 0)
            throw new Error(
              `The command started, but dx couldn't read its pid: ${started.stdout.slice(-200)}`,
            );
        } else {
          if (!Number.isSafeInteger(params.pid) || params.pid <= 0) {
            throw new Error("Unknown shell process pid");
          }
          pid = params.pid;
        }
        // As much output before the read as the longest saved secret's
        // forms can span, so one split between reads is masked whole.
        context = (await environmentMaskerOf(sandbox)).readContextBytes;
        signal?.throwIfAborted();
        // The wait has its own budget; when even that runs out on a slow
        // Orb, the command is still running under its pid.
        result = await guestExec(
          `${prefix}
pid=${pid}
state="$root/$pid"
[[ -d "$state" ]] || { echo "Unknown shell process pid: $pid" >&2; exit 1; }
${index === 2 ? killGroup : ""}
${readScript(index === 2 ? 1000 : wait, context)}`,
          wait + WAIT_SLACK_MS,
        ).catch((cause: unknown) => {
          if (index === 2 || signal?.aborted === true) throw cause;
          logger.warn("Reading a shell command's output failed", {
            pid,
            error: String(cause),
          });
          return undefined;
        });
        signal?.throwIfAborted();
      } catch (error) {
        if (index !== 0 || signal?.aborted !== true) throw error;
        stopStarted();
        throw stoppedError(signal);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (result === undefined) {
        const lines = [
          `<note>The Orb was too slow to read the command's output within the wait. The command keeps running; follow it with shell_command_status.</note>`,
          ...(note === undefined ? [] : [`<note>${note}</note>`]),
          "<running>true</running>",
          `<pid>${pid}</pid>`,
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { pid, running: true, exitCode: undefined },
        };
      }
      if (result.exitCode !== 0)
        throw new Error(
          result.stderr || result.stdout || "Shell process operation failed",
        );
      const [, runningText, codeText, truncated, flushed, beforeHex, keptHex] =
        result.stdout.split("\n");
      const running = runningText === "true";
      const exitCode = running ? undefined : Number(codeText);
      // A secret may have begun before this read, or this read may cut one
      // off: the read shows what the one before held back and holds back
      // what could begin a secret, until the command ends.
      const output =
        (truncated === "1"
          ? "[Output truncated to last 50 KB / 2,000 lines]\n"
          : "") +
        // After the read, so the environment its command checked is reused.
        (await environmentMaskerOf(sandbox)).maskRead(
          bytesOfHex(beforeHex ?? ""),
          bytesOfHex(keptHex ?? ""),
          // A truncated read starts after what was held back; once a read
          // reported the end, it showed everything.
          {
            heldBefore: truncated !== "1" && flushed !== "1",
            final: !running,
            // The context this read asked for is its hold window, even if
            // the secrets changed since, so the next read, asking for its
            // own, finds the same tail when they did not.
            context,
          },
        );
      const lines: string[] = [];
      if (output || !running) lines.push(`<output>${output}</output>`);
      if (!running) lines.push(`<exitCode>${exitCode}</exitCode>`);
      if (note !== undefined) lines.push(`<note>${note}</note>`);
      if (running || index !== 0)
        lines.push(`<running>${running}</running>`, `<pid>${pid}</pid>`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { pid, running, exitCode },
      };
    },
  }));
