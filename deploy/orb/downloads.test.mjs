import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Every download in the Orb installer (install.sh, which the Dockerfile and
// the Boat and Freestyle recipes run) must survive a remote that fails once:
// a public self-host deploy of v0.2.67 died on one HTTP 503 from
// snapshot.debian.org. Each curl command is run here, with its own options,
// against a local server whose first answer for each file is a failure.

const root = resolve(import.meta.dirname, "../..");
const recipes = ["deploy/orb/install.sh"];
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

describe("Orb image downloads", () => {
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
