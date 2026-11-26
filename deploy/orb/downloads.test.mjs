import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Every download in the Orb installer (install.sh, which the Dockerfile and
// the Boat and Freestyle recipes run) and the Claude Code executor image must
// survive a remote that fails once: a public self-host deploy of v0.2.67 died
// on one HTTP 503 from snapshot.debian.org. Each curl command is run here,
// with its own options, against a local server whose first answer for each
// file is a failure. Every file they download must also be checked against
// its pinned SHA-256 before anything uses it (#2608: the Claude Code
// installer once ran unchecked).

const root = resolve(import.meta.dirname, "../..");
const recipes = [
  "deploy/orb/install.sh",
  "deploy/executor/claude-code/Dockerfile",
];
const body = "pinned file\n";

const recipe = (path) => readFileSync(resolve(root, path), "utf8");

/** Every `curl ...` command in a recipe, as shell words. */
const curlCommands = (path) =>
  recipe(path)
    .split(/&&|\|\||[|;\n]/)
    .map((command) =>
      command
        .trim()
        .replace(/^(RUN|do|then|else)\s+/, "")
        .replace(/^\w+=\$\(/, ""),
    )
    .filter((command) => /^curl\s/.test(command))
    .map((command) => command.split(/\s+/));

/** Every curl invoked with options, however the command is written. */
const curlInvocations = (path) =>
  recipe(path)
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .match(/\bcurl\s+-/g)?.length ?? 0;

/**
 * The command's options, without its URL (the last word), its output file,
 * and shell expansions such as an optional header list.
 */
const options = (words) =>
  words
    .slice(1, -1)
    .filter(
      (word, index, all) =>
        word !== "-o" && all[index - 1] !== "-o" && !word.startsWith('"$'),
    );

const downloads = recipes.flatMap((path) =>
  curlCommands(path).map((words) => ({
    path,
    url: words.at(-1),
    options: options(words),
  })),
);

// install.sh's `fetch_toolbelt <file> <sha256> <url>...`, which tries each
// source of the dx toolbelt in order.
const fetchFunction = /^fetch_toolbelt\(\) \{\n[\s\S]*?\n\}$/m.exec(
  recipe("deploy/orb/install.sh"),
);

// /503/<n> answers 503 first, /reset/<n> drops the connection first; every
// later request for the same path gets the file. /down/<n> always answers
// 503 and /tampered/<n> always serves other bytes.
const seen = new Set();
const server = createServer((request, response) => {
  const first = !seen.has(request.url);
  seen.add(request.url);
  if (request.url.startsWith("/down/")) {
    response.writeHead(503).end("No healthy backends");
    return;
  }
  if (request.url.startsWith("/tampered/")) {
    response.writeHead(200).end("not the pinned file\n");
    return;
  }
  if (first && request.url.startsWith("/503/")) {
    response.writeHead(503).end("Service Unavailable");
    return;
  }
  if (first && request.url.startsWith("/reset/")) {
    request.socket.destroy();
    return;
  }
  response.writeHead(200).end(body);
});

let origin;
beforeAll(async () => {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((done) => server.close(done)));

const directory = mkdtempSync(join(tmpdir(), "dx-orb-downloads-"));

const run = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, { stdio: "pipe", ...options });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => done({ status, stderr }));
  });

const curl = (args, output) => run("curl", [...args, "-o", output]);

/** Runs install.sh's fetch_toolbelt in a fresh directory. */
const fetchToolbelt = async (urls) => {
  const cwd = mkdtempSync(join(directory, "fetch-"));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const file = join(cwd, "dx-toolbelt.tar.zst");
  const result = await run(
    "bash",
    [
      "-c",
      `${fetchFunction[0]}\nfetch_toolbelt "$@"`,
      "bash",
      file,
      sha256,
      ...urls,
    ],
    { cwd },
  );
  return {
    ...result,
    kept: existsSync(file) ? readFileSync(file, "utf8") : undefined,
  };
};

/** Every download a recipe writes to a file: the curl words and the file. */
const savedDownloads = (path) =>
  curlCommands(path)
    .filter((words) => words.includes("-o"))
    .map((words) => ({ words, output: words[words.indexOf("-o") + 1] }));

/** The shell statement of a recipe that checks a downloaded file's SHA-256. */
const checksumCheck = (path, output) => {
  const text = recipe(path);
  const saved = text.indexOf(`-o ${output}`);
  const next = text.indexOf(output, saved + 3 + output.length);
  if (saved < 0 || next < 0) return undefined;
  // The `&&`-separated part of that line around the use.
  const start = Math.max(
    text.lastIndexOf("\n", next) + 1,
    text.lastIndexOf("&&", next) + 2,
  );
  const ends = [text.indexOf("\n", next), text.indexOf("&&", next)].filter(
    (end) => end >= 0,
  );
  const statement = text.slice(start, Math.min(...ends)).trim();
  return statement.includes(`sha256sum ${output}`) ? statement : undefined;
};

/** install.sh's top-level pins, such as CLAUDE_CODE_VERSION=2.1.326. */
const pins = Object.fromEntries(
  [...recipe("deploy/orb/install.sh").matchAll(/^([A-Z0-9_]+)=(\S+)$/gm)].map(
    ([, name, value]) => [name, value],
  ),
);

/** Major, minor, patch, compared in order. */
const atLeast = (version, minimum) => {
  const [a, b] = [version, minimum].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

describe("Orb image downloads", () => {
  it("checks the SHA-256 of every downloaded file before using it", () => {
    for (const path of recipes) {
      const saved = savedDownloads(path);
      expect(saved.length, path).toBeGreaterThan(0);
      for (const { output } of saved)
        expect(
          checksumCheck(path, output),
          `${path}: the first use of ${output} after its download is not a SHA-256 check`,
        ).toBeDefined();
      // A download piped or substituted into a shell runs unchecked.
      expect(recipe(path), path).not.toMatch(
        /curl[^\n]*\|\s*(sudo\s+(-\S+\s+)*)?(ba|z|da)?sh\b|(ba)?sh\s+<\(\s*curl/,
      );
    }
  });

  it("fails a download that does not match its pinned SHA-256", async () => {
    const pinnedBody = createHash("sha256").update(body).digest("hex");
    // fetch_toolbelt checks against its <sha256> argument, the toolbelt pin.
    const assignments = Object.entries(pins)
      .map(([name, value]) => `${name}=${value}`)
      .concat("sum=$TOOLBELT_SHA256")
      .join("\n");
    const runs = recipes.flatMap((path) =>
      savedDownloads(path).flatMap(({ words, output }, index) =>
        ["tampered", "good"].map(async (served) => {
          const cwd = mkdtempSync(join(directory, "check-"));
          let check = checksumCheck(path, output).replaceAll(
            output,
            '"$PWD/dl"',
          );
          let script = assignments;
          // The control: the same check, pinned to the bytes served.
          if (served === "good") {
            check = check.replace(/\b[a-f0-9]{64}\b/g, pinnedBody);
            script = script.replace(/\b[a-f0-9]{64}\b/g, pinnedBody);
          }
          const download = ["curl", ...options(words), "-o", '"$PWD/dl"']
            .concat(`${origin}/${served}/${path}/${index}`)
            .join(" ");
          const result = await run(
            "bash",
            ["-c", `set -euo pipefail\n${script}\n${download}\n${check}`],
            { cwd },
          );
          return { download: `${path}: ${output}`, served, ...result };
        }),
      ),
    );
    const results = await Promise.all(runs);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results)
      if (result.served === "good")
        expect(result.status, `${result.download}: ${result.stderr}`).toBe(0);
      else expect(result.status, result.download).not.toBe(0);
  }, 60_000);

  it("pins one Claude Code release, one Core can run, in both images", () => {
    const { CLAUDE_CODE_VERSION: version, CLAUDE_CODE_SHA256: sha256 } = pins;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    const executor = recipe("deploy/executor/claude-code/Dockerfile");
    expect(executor).toContain(
      `/claude-code-releases/${version}/linux-x64/claude`,
    );
    expect(executor.match(new RegExp(sha256, "g"))?.length).toBe(2);
    // An older image release makes every Orb install `latest` at first use,
    // which no pin covers (apps/core/src/claude-code/workspace-run.ts).
    const minimum = /CLAUDE_CODE_MIN_VERSION = "([\d.]+)"/.exec(
      recipe("apps/core/src/claude-code/workspace-run.ts"),
    )?.[1];
    expect(minimum).toBeDefined();
    expect(atLeast(version, minimum), `${version} >= ${minimum}`).toBe(true);
  });

  it("finds every download in the recipe", () => {
    for (const path of recipes)
      expect(
        downloads.filter((download) => download.path === path).length,
        path,
      ).toBe(curlInvocations(path));
    expect(downloads.length).toBeGreaterThan(0);
  });

  it("fails on a single 503 without retries (the server really fails)", async () => {
    const result = await curl(
      ["-fsSL", `${origin}/503/control`],
      join(directory, "control"),
    );
    expect(result.status).toBe(22);
  });

  it("recovers every download from a 503 and from a dropped connection", async () => {
    const runs = downloads.flatMap((download, index) =>
      ["503", "reset"].map(async (failure) => {
        const file = join(directory, `${failure}-${index}`);
        const result = await curl(
          [...download.options, `${origin}/${failure}/${index}`],
          file,
        );
        return {
          download: `${download.path}: ${download.url}`,
          failure,
          status: result.status,
          stderr: result.stderr,
          body: result.status === 0 ? readFileSync(file, "utf8") : undefined,
        };
      }),
    );
    for (const run of await Promise.all(runs))
      expect(run, `${run.download} after a ${run.failure}`).toMatchObject({
        status: 0,
        body,
      });
  }, 60_000);

  it("falls through a dead source and a tampered one to the next source", async () => {
    expect(fetchFunction, "install.sh's fetch_toolbelt").not.toBeNull();
    const [recovered, exhausted] = await Promise.all([
      fetchToolbelt([
        `${origin}/down/a`,
        `${origin}/tampered/a`,
        `${origin}/good/a`,
      ]),
      fetchToolbelt([`${origin}/down/b`, `${origin}/tampered/b`]),
    ]);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.kept).toBe(body);
    expect(exhausted.status).not.toBe(0);
    expect(exhausted.stderr).toContain("no source served the dx toolbelt");
  }, 60_000);
});
