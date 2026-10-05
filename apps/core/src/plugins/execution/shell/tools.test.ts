import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@flue/runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { shellDefinitions } from "./definitions.js";
import { createShellTools, shellWaitMs } from "./tools.js";

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

it("exports the exact ordered definitions", () => {
  expect(
    tools().map(({ name, description, parameters }) => ({
      name,
      description,
      parameters: JSON.parse(JSON.stringify(parameters)),
    })),
  ).toEqual(shellDefinitions);
  expect(tools().map((tool) => Object.keys(tool.parameters))).toEqual(
    shellDefinitions.map((definition) => Object.keys(definition.parameters)),
  );
});
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
it("clamps timeout values", () => {
  expect([undefined, -20, 0, 123.8, 90000].map(shellWaitMs)).toEqual([
    10000, 0, 0, 123, 60000,
  ]);
});
it("aborts the wait but leaves the background command running", async () => {
  const controller = new AbortController();
  const pending = call(
    0,
    { command: "sleep 0.5; echo survived", timeout_ms: 10000 },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 100);
  await expect(pending).rejects.toThrow();
  const root = join(home, ".local/state/dx-shell");
  const pid = Number(
    (await readdir(root)).find((entry) => /^\d+$/.test(entry)),
  );
  expect((await call(1, { pid, timeout_ms: 2000 })).text).toContain(
    "survived\n</output>",
  );
  expect(await readFile(join(root, String(pid), "exit"), "utf8")).toBe("0");
});
