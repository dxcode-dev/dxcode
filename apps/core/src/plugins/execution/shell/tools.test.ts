import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@flue/runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createShellTools } from "./tools.js";

let home: string;
let sandbox: Sandbox;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "dx-shell-test-"));
  sandbox = {
    exec: (command, options) =>
      new Promise((resolve, reject) => {
        execFile(
          "bash",
          ["-c", command],
          {
            cwd: options?.cwd,
            env: { ...process.env, ...options?.env, HOME: home },
            timeout: options?.timeoutMs,
            signal: options?.signal,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error && (error.name === "AbortError" || error.killed))
              reject(error);
            else
              resolve({
                stdout,
                stderr,
                exitCode: error ? Number(error.code) || 1 : 0,
              });
          },
        );
      }),
  } as Sandbox;
});
afterEach(async () => {
  const root = join(home, ".local/state/dx-shell");
  for (const entry of await readdir(root).catch(() => [])) {
    if (/^\d+$/.test(entry)) {
      await createShellTools(sandbox)[2].execute("cleanup", {
        pid: Number(entry),
      });
    }
  }
  await rm(home, { recursive: true, force: true });
});
const tools = () => createShellTools(sandbox, { defaultWorkdir: home });
const call = async (
  index: number,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => {
  const result = await tools()[index].execute("test", params, signal);
  return {
    text: result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
    details: result.details as {
      pid: number;
      running: boolean;
      exitCode?: number;
    },
  };
};

it("formats a quick exit and preserves merged output and safe quoting", async () => {
  expect(
    (await call(0, { command: `printf "a'\\n"; printf 'b\\n' >&2; exit 7` }))
      .text,
  ).toBe("<output>a'\nb\n</output>\n<exitCode>7</exitCode>");
});
it("follows a real group leader across factory instances and reads only new output", async () => {
  const first = await call(0, {
    command: "echo first; sleep 0.5; echo second",
    timeout_ms: 100,
  });
  expect(first.details.running).toBe(true);
  expect(first.text).toContain("<output>first\n</output>");
  const pid = first.details.pid;
  expect((await sandbox.exec(`ps -o pgid= -p ${pid}`)).stdout.trim()).toBe(
    String(pid),
  );
  const final = await call(1, { pid, timeout_ms: 2000 });
  expect(final.text).toBe(
    `<output>second\n</output>\n<exitCode>0</exitCode>\n<running>false</running>\n<pid>${pid}</pid>`,
  );
  expect((await call(1, { pid, timeout_ms: 0 })).text).toBe(
    `<output></output>\n<exitCode>0</exitCode>\n<running>false</running>\n<pid>${pid}</pid>`,
  );
});
it("returns a bare running result without output", async () => {
  const result = await call(0, { command: "sleep 10", timeout_ms: 0 });
  expect(result.text).toBe(
    `<running>true</running>\n<pid>${result.details.pid}</pid>`,
  );
});
it("kills a process group including TERM-resistant children", async () => {
  const result = await call(0, {
    command: "trap '' TERM; sleep 30 & echo $!; wait",
    timeout_ms: 100,
  });
  const child = Number(result.text.match(/<output>(\d+)/)?.[1]);
  expect(child).toBeGreaterThan(0);
  const killed = await call(2, { pid: result.details.pid });
  expect(killed.details.running).toBe(false);
  const state = await sandbox.exec(`ps -o stat= -p ${child}`);
  expect(
    state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
  ).toBe(true);
});
it("rejects missing workdir before starting anything", async () => {
  await expect(
    call(0, { command: "echo wrong", workdir: join(home, "missing") }),
  ).rejects.toThrow("Working directory does not exist");
  expect(await readdir(home)).toEqual([]);
});
it("rejects unknown and invalid pids", async () => {
  await expect(call(1, { pid: 99999999 })).rejects.toThrow(
    "Unknown shell process pid",
  );
  await expect(call(2, { pid: -1 })).rejects.toThrow(
    "Unknown shell process pid",
  );
});
it("caps bytes and lines and consumes discarded output", async () => {
  const result = await call(0, { command: "seq 1 12000" });
  expect(result.text).toContain(
    "[Output truncated to last 50 KB / 2,000 lines]\n",
  );
  expect(result.text).toContain("12000\n</output>");
  expect(result.text.length).toBeLessThan(51300);
  expect(result.text.split("\n").length).toBeLessThan(2005);
  expect((await call(1, { pid: result.details.pid })).text).toContain(
    "<output></output>",
  );
});
const startedPid = async () =>
  (await readdir(join(home, ".local/state/dx-shell")).catch(() => [])).find(
    (entry) => /^\d+$/.test(entry),
  );
const until = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const gone = async (pid: number) => {
  const state = (await sandbox.exec(`ps -o stat= -p ${pid}`)).stdout.trim();
  return state === "" || state.startsWith("Z");
};

it("Stop during shell_command ends the command and its TERM-resistant children", async () => {
  const controller = new AbortController();
  const probe = join(home, "probe.txt");
  const pending = call(
    0,
    {
      command: `trap '' TERM; (trap '' TERM; while true; do echo tick >> ${probe}; sleep 0.1; done) & echo $! > ${join(home, "child")}; wait`,
      timeout_ms: 10000,
    },
    controller.signal,
  );
  await until(
    async () => (await readFile(probe, "utf8").catch(() => "")) !== "",
  );
  controller.abort();
  await expect(pending).rejects.toThrow("Stopped with the turn");
  // The start directory, not the pid alias: Stop can end the start script
  // before it links the alias.
  const root = join(home, ".local/state/dx-shell");
  const start = (await readdir(root)).find((entry) =>
    entry.startsWith("start."),
  );
  const pid = Number(await readFile(join(root, String(start), "pid"), "utf8"));
  const child = Number(await readFile(join(home, "child"), "utf8"));
  expect(pid).toBeGreaterThan(0);
  await until(async () => (await gone(pid)) && (await gone(child)));
  // The runner records SIGTERM; SIGKILL then ends the children ignoring it.
  await until(
    async () =>
      (await readFile(join(root, String(start), "exit"), "utf8").catch(
        () => "",
      )) !== "",
  );
  expect(await readFile(join(root, String(start), "exit"), "utf8")).toBe("143");
  const lines = (await readFile(probe, "utf8")).length;
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect((await readFile(probe, "utf8")).length).toBe(lines);
});
it("Stop while following with shell_command_status leaves the background command running", async () => {
  const started = await call(0, {
    command: "sleep 0.8; echo survived",
    timeout_ms: 0,
  });
  const controller = new AbortController();
  const pending = call(
    1,
    { pid: started.details.pid, timeout_ms: 10000 },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(
    (await call(1, { pid: started.details.pid, timeout_ms: 5000 })).text,
  ).toContain("survived\n</output>\n<exitCode>0</exitCode>");
});
it("a Stop that reaches the Orb before the start never runs the command", async () => {
  // Flue rejects an aborted exec at once and leaves it running, so the start
  // can reach the Orb after the stop does.
  const real = sandbox;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  sandbox = {
    exec: (command, options) => {
      const { signal, ...rest } = options ?? {};
      const delayed = first;
      first = false;
      const run = delayed
        ? held.then(() => real.exec(command, rest))
        : real.exec(command, rest);
      if (signal === undefined) return run;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        run.then(resolve, reject);
      });
    },
  } as Sandbox;
  const controller = new AbortController();
  const marker = join(home, "ran");
  const pending = call(
    0,
    { command: `touch ${marker}`, timeout_ms: 10000 },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toThrow("Stopped with the turn");
  const root = join(home, ".local/state/dx-shell");
  await until(async () =>
    (await readdir(root).catch(() => [])).some((entry) =>
      entry.startsWith("start."),
    ),
  );
  release();
  await new Promise((resolve) => setTimeout(resolve, 500));
  sandbox = real;
  await expect(readFile(marker)).rejects.toThrow();
  expect(await startedPid()).toBeUndefined();
});
