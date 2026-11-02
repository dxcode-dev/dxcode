#!/usr/bin/env node
// Checks the deploying machine's Node.js and pnpm before a self-host deploy:
//
//   node deploy/selfhost/toolchain.mjs
//
// Each problem is one line naming what this release needs. `pnpm dx:deploy`
// and the deploy runner check the same before they start.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");

const parseVersion = (value) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "").trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
};

const compare = (left, right) => {
  for (let index = 0; index < 3; index += 1)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
};

/** Whether `version` meets every comparator of a range like `>=12.14.0 <13`. */
export const satisfies = (version, range) => {
  const actual = parseVersion(version);
  if (actual === undefined) return false;
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const match = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(
        comparator,
      );
      if (!match) throw new Error(`Unsupported version range: ${range}`);
      const [, operator = "=", major, minor = "0", patch = "0"] = match;
      const order = compare(actual, [major, minor, patch].map(Number));
      return {
        ">=": order >= 0,
        "<=": order <= 0,
        ">": order > 0,
        "<": order < 0,
        "=": order === 0,
      }[operator];
    });
};

/** The settings pnpm-lock.yaml records, which a frozen install must match. */
const lockfileSettings = (lockfile) => {
  const block = /^settings:\n((?: {2}\S[^\n]*\n)+)/m.exec(lockfile)?.[1] ?? "";
  return [...block.matchAll(/^ {2}([A-Za-z]+): *([^\n]*)$/gm)].map(
    ([, name, value]) => [name, value.trim()],
  );
};

const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter}`);

/** pnpm's own version: from `pnpm …`'s user agent, else `pnpm --version`. */
export const runningPnpmVersion = (environment = process.env, root = ROOT) => {
  const agent = /\bpnpm\/(\d+\.\d+\.\d+)/.exec(
    environment.npm_config_user_agent ?? "",
  )?.[1];
  if (agent) return agent;
  const result = spawnSync("pnpm", ["--version"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  });
  return result.status === 0 ? result.stdout.trim().split("\n").at(-1) : "";
};

/**
 * One line per problem that would stop this release installing or deploying
 * on this machine; empty when there is none.
 */
export const toolchainProblems = ({
  root = ROOT,
  nodeVersion = process.versions.node,
  pnpmVersion,
  environment = process.env,
} = {}) => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json")));
  const wanted = manifest.packageManager?.replace(/^pnpm@/, "").split("+")[0];
  const problems = [];
  if (manifest.engines?.node && !satisfies(nodeVersion, manifest.engines.node))
    problems.push(
      `dx needs Node.js ${manifest.engines.node}; this is ${nodeVersion}. Install a newer Node.js and retry.`,
    );
  const pnpm = pnpmVersion ?? runningPnpmVersion(environment, root);
  if (
    manifest.engines?.pnpm &&
    (!pnpm || !satisfies(pnpm, manifest.engines.pnpm))
  )
    problems.push(
      `dx needs pnpm ${wanted ?? manifest.engines.pnpm}; this is ${pnpm || "no pnpm"}. Run \`corepack enable\` (or install pnpm ${wanted ?? manifest.engines.pnpm}) and retry.`,
    );
  let lockfile = "";
  try {
    lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  } catch {}
  for (const [setting, recorded] of lockfileSettings(lockfile))
    for (const [name, value] of Object.entries(environment))
      if (
        new RegExp(`^(?:pnpm|npm)_config_${snake(setting)}$`, "i").test(
          name.replaceAll("-", "_"),
        ) &&
        String(value).trim().toLowerCase() !== recorded.toLowerCase()
      )
        problems.push(
          `Unset ${name}: it changes "${setting}", which pnpm-lock.yaml records, so \`pnpm install --frozen-lockfile\` refuses the install.`,
        );
  return problems;
};

/** Stops a deploy on the first toolchain problem, with its one line. */
export const assertToolchain = (options) => {
  const problems = toolchainProblems(options);
  if (problems.length > 0) throw new Error(problems.join("\n"));
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = toolchainProblems();
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(
    `Node.js ${process.versions.node} and pnpm ${runningPnpmVersion()} meet this release's requirements.`,
  );
}
