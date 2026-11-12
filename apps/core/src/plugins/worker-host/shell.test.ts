import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@flue/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "./host.js";
import {
  type PluginShellDecision,
  type PluginShellGate,
  pluginShellRunner,
  SHELL_OUTPUT_BYTES,
  SHELL_RUNS_PER_CALL,
  shellProgramOf,
} from "./shell.js";

/**
 * A plugin's commands against real bash, standing in for the Orb: what
 * reaches the guest, what comes back, and what the audit records. Ways it
 * could fail, each checked below:
 *
 * - a non-zero exit rejects instead of resolving, or stdout and stderr mix
 * - a command outlives its time limit, or a huge output is carried whole
 * - cwd leaves the checkout (`..`, `/`, `~`)
 * - a gate's reject still runs the command, or its modify is ignored
 * - a call runs unbounded commands, or keeps running after it ended
 * - the audit stores command text or output, or skips a refused command
 */

let checkout: string;
let ran: Array<string>;
let opened: number;
const sandbox = (): Sandbox =>
  ({
    cwd: checkout,
    exec: (command: string, options?: { timeoutMs?: number }) =>
      new Promise((resolve, reject) => {
        ran.push(command);
        execFile(
          "bash",
          ["-c", command],
          { cwd: checkout, timeout: options?.timeoutMs, maxBuffer: 8 << 20 },
          (error, stdout, stderr) => {
            if (error?.killed) reject(error);
            else
              resolve({
                stdout,
                stderr,
                exitCode: error ? Number(error.code) || 1 : 0,
              });
          },
        );
      }),
  }) as unknown as Sandbox;

/** D1 stand-in that keeps each audit row's bound values. */
const auditDb = () => {
  const rows: Array<Array<unknown>> = [];
  const db = {
    prepare: () => ({
      bind: (...values: Array<unknown>) => ({
        run: async () => {
          rows.push(values);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as D1Database;
  const audits = () =>
    rows.map((values) => ({
      action: values[7],
      target: values[8],
      outcome: values[9],
      detail: JSON.parse(String(values[10])) as Record<string, unknown>,
    }));
  return { db, audits };
};

const install = {
  pluginId: "plg_shell_test",
  name: "com.acme.shell",
  displayName: "Shell test",
  scope: "personal",
  targetId: "usr_1",
  version: "1.0.0+abc",
  integrity: "sha256-x",
  code: {} as PluginInstallRecord["code"],
} as PluginInstallRecord;

const allow: PluginShellGate = async (input) => ({ kind: "allow", input });
const alive = (pid: string) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Thread's sandbox masks secrets in what exec returns, including their
 * base64 forms; this one rewrites a secret's raw and base64 forms the same
 * way, at every offset.
 */
const SECRET = "TOPSECRET-value-1234567890";
const maskingSandbox = (): Sandbox => {
  const inner = sandbox();
  const forms = [0, 1, 2].flatMap((shift) => {
    const encoded = btoa("x".repeat(shift) + SECRET).slice(
      4 * Math.ceil(shift / 3) + 1,
      -2,
    );
    return encoded.length > 8 ? [encoded] : [];
  });
  return {
    ...inner,
    cwd: checkout,
    exec: async (command: string, options?: { timeoutMs?: number }) => {
      const reply = await inner.exec(command, options);
      let stdout = reply.stdout.replaceAll(SECRET, "[masked]");
      for (const form of forms) stdout = stdout.replaceAll(form, "[masked]");
      return { ...reply, stdout };
    },
  } as unknown as Sandbox;
};

const runner = (
  gate: PluginShellGate = allow,
  isOpen: () => boolean = () => true,
  openSandbox: () => Sandbox = sandbox,
) => {
  const { db, audits } = auditDb();
  return {
    audits,
    shell: pluginShellRunner({
      db,
      install,
      threadId: "thr_1",
      ownerUserId: "usr_1",
      gate,
      isOpen,
      openWorkspace: async () => {
        opened += 1;
        return openSandbox();
      },
    }),
  };
};

beforeEach(async () => {
  checkout = await mkdtemp(join(tmpdir(), "dx-plugin-shell-"));
  await mkdir(join(checkout, "sub"));
  ran = [];
  opened = 0;
});
afterEach(async () => {
  await rm(checkout, { recursive: true, force: true });
});

describe("plugin shell commands", () => {
  it("resolves exit code, stdout and stderr apart, in the checkout", async () => {
    const { shell, audits } = runner();
    const result = await shell.run({
      command: "pwd; echo to-err >&2; exit 3",
    });
    expect(result).toEqual({
      exitCode: 3,
      stdout: `${checkout}\n`,
      stderr: "to-err\n",
      timedOut: false,
      truncated: false,
    });
    const sub = await shell.run({ command: "pwd", cwd: "sub/" });
    expect(sub.stdout).toBe(`${join(checkout, "sub")}\n`);
    // One workspace per call.
    expect(opened).toBe(1);
    const [first] = audits();
    expect(first).toMatchObject({
      action: "shell.exec",
      target: "thr_1",
      outcome: "success",
      detail: { program: "pwd", exitCode: 3, cwd: ".", timedOut: false },
    });
    // The audit keeps a hash, never the command line or its output.
    expect(JSON.stringify(audits())).not.toContain("to-err");
    expect(first?.detail.commandSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps binary-safe output and a login profile's noise out", async () => {
    const { shell } = runner();
    const result = await shell.run({
      command: "printf 'a\\nDXSHELL2 9 9 9 1\\n\\xff b'",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\nDXSHELL2 9 9 9 1\n� b");
  });

  it("stops a command at its time limit", async () => {
    const { shell, audits } = runner();
    const started = Date.now();
    const result = await shell.run({
      command: "trap '' TERM; sleep 30",
      timeoutMs: 1_000,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.timedOut).toBe(true);
    expect([124, 137]).toContain(result.exitCode);
    expect(audits()[0]?.detail).toMatchObject({ timedOut: true });
  }, 15_000);

  it("keeps only the first bytes of a large output", async () => {
    const { shell } = runner();
    const result = await shell.run({
      command: `head -c ${SHELL_OUTPUT_BYTES * 2} /dev/zero | tr '\\0' x`,
    });
    expect(result.truncated).toBe(true);
    // The cut also drops the masker's read context (4 KB here), where a
    // secret split by the cut could start.
    expect(result.stdout.length).toBe(SHELL_OUTPUT_BYTES - 4_096);
  });

  it("refuses folders outside the checkout without reaching the Orb", async () => {
    const { shell, audits } = runner();
    for (const cwd of ["../", "/etc", "~", "sub/../../x"])
      await expect(shell.run({ command: "ls", cwd })).rejects.toThrow(
        /relative to the Thread's checkout/,
      );
    await expect(shell.run({ command: "ls", timeoutMs: 10 })).rejects.toThrow(
      /timeoutMs/,
    );
    expect(ran).toEqual([]);
    expect(audits().map(({ outcome }) => outcome)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
  });

  it("follows the Thread's tool.call gate", async () => {
    const seen: Array<unknown> = [];
    const gate: PluginShellGate = async (input) => {
      seen.push(input);
      const decision: PluginShellDecision = input.command.includes("--force")
        ? { kind: "reject", message: "Force pushes are blocked." }
        : input.command === "rewrite"
          ? {
              kind: "allow",
              input: { command: "pwd", workdir: join(checkout, "sub") },
            }
          : input.command === "fake"
            ? { kind: "synthesize", output: "from the gate" }
            : { kind: "allow", input };
      return decision;
    };
    const { shell, audits } = runner(gate);
    await expect(
      shell.run({ command: "git push --force origin main" }),
    ).rejects.toThrow("Force pushes are blocked.");
    expect(ran).toEqual([]);
    // A modify's absolute folder inside the checkout is honoured.
    expect((await shell.run({ command: "rewrite" })).stdout).toBe(
      `${join(checkout, "sub")}\n`,
    );
    expect(await shell.run({ command: "fake" })).toMatchObject({
      exitCode: 0,
      stdout: "from the gate",
    });
    expect(ran).toHaveLength(1);
    expect(seen[0]).toEqual({
      command: "git push --force origin main",
      workdir: checkout,
    });
    expect(audits().map(({ outcome }) => outcome)).toEqual([
      "rejected",
      "success",
      "success",
    ]);
    // The handler's message may quote the command; the audit keeps none.
    expect(audits()[0]?.detail).toMatchObject({
      program: "git",
      by: "tool.call",
    });
    expect(JSON.stringify(audits())).not.toContain("Force pushes");
  });

  it("bounds a call's commands and stops after the call ends", async () => {
    let open = true;
    const { shell } = runner(allow, () => open);
    const parallel = await Promise.allSettled(
      Array.from({ length: 6 }, () => shell.run({ command: "sleep 0.3" })),
    );
    expect(parallel.filter(({ status }) => status === "rejected")).toHaveLength(
      2,
    );
    for (let index = 6; index < SHELL_RUNS_PER_CALL; index += 1)
      await shell.run({ command: "true" });
    await expect(shell.run({ command: "true" })).rejects.toThrow(
      `at most ${SHELL_RUNS_PER_CALL} commands`,
    );
    const ended = runner(allow, () => open);
    open = false;
    await expect(ended.shell.run({ command: "true" })).rejects.toThrow(
      /call has ended/,
    );
  }, 20_000);

  it("kills what the command left running, and keeps a flood off the disk", async () => {
    const { shell } = runner();
    const result = await shell.run({
      command: "sleep 30 & echo $!; yes | head -c 50000000; exit 0",
      timeoutMs: 20_000,
    });
    const child = result.stdout.split("\n")[0] ?? "";
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(child)).toBe(false);
    // The guest's temporary folder held at most the kept bytes.
    expect(ran[0]).toContain(`count=${SHELL_OUTPUT_BYTES + 1}`);
  }, 20_000);

  it("stops a running command when the call ends", async () => {
    const { shell } = runner();
    const running = shell.run({
      command: "echo $$ > pid; sleep 30",
      timeoutMs: 30_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const started = Date.now();
    shell.stop();
    const result = await running;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  }, 20_000);

  it("never audits an assignment as the program, and caps refused rows", async () => {
    const { shell, audits } = runner(async () => ({
      kind: "reject",
      message: "no",
    }));
    await expect(
      shell.run({ command: "GH_TOKEN=ghp_secret" }),
    ).rejects.toThrow();
    for (let index = 0; index < 8; index += 1)
      await shell.run({ command: "ls" }).catch(() => undefined);
    expect(audits()[0]?.detail.program).toBe("");
    expect(JSON.stringify(audits())).not.toContain("ghp_secret");
    expect(audits()).toHaveLength(5);
  });

  it("reads its reply back through a sandbox that masks secrets and their base64", async () => {
    const { shell } = runner(allow, () => true, maskingSandbox);
    const result = await shell.run({
      command: `for n in 1 2 3; do printf '%s %s\\n' "$n" ${SECRET}; done; printf ${SECRET} >&2`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`1 ${SECRET}\n2 ${SECRET}\n3 ${SECRET}\n`);
    expect(result.stderr).toBe(SECRET);
  });

  it("answers on time when a child left the command's group holding its output", async () => {
    const { shell } = runner();
    const started = Date.now();
    const result = await shell.run({
      command: "(set -m; sleep 15 &); echo done",
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe("done\n");
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 20_000);

  it("stops a command that was still starting when the call ended", async () => {
    const { shell } = runner();
    const running = shell.run({ command: "sleep 20", timeoutMs: 30_000 });
    // Stop the moment the guest is asked, before it records the group.
    while (ran.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    shell.stop();
    const result = await running;
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.exitCode).not.toBe(0);
    // Nothing more starts once the call has ended.
    await expect(shell.run({ command: "true" })).rejects.toThrow(
      /call has ended/,
    );
  }, 30_000);

  it("names only a clean program in the audit", () => {
    expect(shellProgramOf("git status")).toBe("git");
    expect(shellProgramOf("A=1 B=2 ./run.sh --x")).toBe("./run.sh");
    expect(shellProgramOf('TOKEN="hunter2 pass" curl x')).toBe("");
    expect(shellProgramOf("PASS=$'a b' cmd")).toBe("");
    expect(shellProgramOf("GH_TOKEN=ghp_x")).toBe("");
  });
});
