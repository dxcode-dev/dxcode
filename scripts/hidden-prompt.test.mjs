import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createHiddenPrompt } from "./hidden-prompt.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

const pseudoTerminalSequence = async (administratorPassword) => {
  const directory = await mkdtemp(join(tmpdir(), "dx-hidden-prompt-"));
  const harness = join(directory, "harness.mjs");
  const helper = pathToFileURL(resolve("scripts/hidden-prompt.mjs")).href;
  await writeFile(
    harness,
    `import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createHiddenPrompt } from ${JSON.stringify(helper)};
let readline = createInterface({ input: stdin, output: stdout });
const hidden = createHiddenPrompt({
  input: stdin,
  output: stdout,
  pause: () => readline.close(),
  resume: () => { readline = createInterface({ input: stdin, output: stdout }); },
});
const administrator = await hidden("Administrator password");
if (administrator.length > 0) await hidden("Confirm administrator password");
const e2b = await hidden("E2B API key");
stdout.write(
  "RESULT:" + administrator.length + ":" + e2b.length + "\\n",
);
readline.close();
`,
  );
  try {
    const child = spawn(
      "script",
      ["-qec", `${process.execPath} ${harness}`, "/dev/null"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    const answers = [
      ["Administrator password: ", `${administratorPassword}\r`],
      ...(administratorPassword === ""
        ? []
        : [["Confirm administrator password: ", `${administratorPassword}\r`]]),
      ["E2B API key: ", "fixture-e2b-key\r"],
    ];
    let answerIndex = 0;
    const answer = () => {
      const next = answers[answerIndex];
      if (next && output.includes(next[0])) {
        answerIndex += 1;
        child.stdin.write(next[1]);
      }
    };
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      answer();
    });
    child.stderr.on("data", (chunk) => {
      error += chunk.toString("utf8");
    });
    const exit = await new Promise((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Hidden prompt pseudo-terminal timed out."));
      }, 5_000);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    });
    return { ...exit, output, error };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const fixture = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rawModes = [];
  const errors = [];
  let printed = "";
  Object.defineProperty(input, "isTTY", { value: true });
  input.setRawMode = vi.fn((mode) => rawModes.push(mode));
  input.on("error", (error) => errors.push(error));
  output.on("data", (chunk) => {
    printed += chunk.toString("utf8");
  });
  let readline;
  const openReadline = () => {
    readline = createInterface({ input, output });
    readline.on("error", (error) => errors.push(error));
  };
  openReadline();
  const hidden = createHiddenPrompt({
    input,
    output,
    pause: () => readline.close(),
    resume: openReadline,
  });
  const enter = async (value) => {
    await tick();
    for (const character of value) {
      input.write(character);
      await tick();
    }
    input.write("\r");
  };
  return {
    input,
    output,
    hidden,
    enter,
    errors,
    rawModes,
    printed: () => printed,
    question: (label) => readline.question(label),
    close: () => readline.close(),
  };
};

describe("hidden terminal prompts", () => {
  it.each([
    ["generated administrator password", ""],
    ["supplied administrator password", "fixture-admin-password"],
  ])(
    "keeps real TTY stdin healthy through E2B input after %s",
    async (_label, administratorPassword) => {
      const result = await pseudoTerminalSequence(administratorPassword);

      expect(result).toMatchObject({ code: 0, signal: null, error: "" });
      expect(result.output).toContain(
        `RESULT:${administratorPassword.length}:15`,
      );
      expect(result.output).not.toContain("AbortError");
      expect(result.output).not.toContain("fixture-e2b-key");
      if (administratorPassword)
        expect(result.output).not.toContain(administratorPassword);
    },
  );

  it.each([
    ["generated administrator password", ""],
    ["supplied administrator password", "fixture-admin-password"],
  ])("accepts E2B input after %s", async (_label, administratorPassword) => {
    const f = fixture();
    const first = f.hidden("Administrator password");
    await f.enter(administratorPassword);
    await expect(first).resolves.toBe(administratorPassword);

    const second = f.hidden("E2B API key");
    await f.enter("fixture-e2b-key");
    await expect(second).resolves.toBe("fixture-e2b-key");
    await tick();

    expect(f.input.destroyed).toBe(false);
    expect(f.errors).toEqual([]);
    expect(f.printed()).not.toContain(administratorPassword || "generated");
    expect(f.printed()).not.toContain("fixture-e2b-key");
    expect(f.rawModes).toEqual([true, false, true, false]);
    f.close();
    f.input.destroy();
    f.output.destroy();
  });

  it("supports an ordinary prompt after a hidden prompt", async () => {
    const f = fixture();
    const hidden = f.hidden("Secret");
    await f.enter("fixture-secret");
    await expect(hidden).resolves.toBe("fixture-secret");

    const ordinary = f.question("Continue: ");
    await f.enter("yes");
    await expect(ordinary).resolves.toBe("yes");
    expect(f.errors).toEqual([]);
    f.close();
    f.input.destroy();
    f.output.destroy();
  });

  it("cancels on Ctrl-C without exposing input", async () => {
    const f = fixture();
    const hidden = f.hidden("Secret");
    await tick();
    f.input.write("\u0003");
    await expect(hidden).rejects.toThrow("Deployment cancelled.");
    expect(f.input.destroyed).toBe(false);
    expect(f.errors).toEqual([]);
    expect(f.rawModes).toEqual([true, false]);
    f.close();
    f.input.destroy();
    f.output.destroy();
  });

  it("returns collected input on EOF", async () => {
    const f = fixture();
    const hidden = f.hidden("Secret");
    await tick();
    f.input.write("partial");
    f.input.end();
    await expect(hidden).resolves.toBe("partial");
    expect(f.rawModes).toEqual([true, false]);
    f.close();
    f.output.destroy();
  });
});
