// The self-host toolchain check, run as a deployer runs it. Ways it could fail,
// each covered below:
// - an old Node.js, a pnpm of another major, or no pnpm passes;
// - a newer pnpm 12 or a matching PNPM_CONFIG_* value fails, so it cries wolf;
// - an npm_config_* spelling of a lockfile setting slips through;
// - a problem prints more than one line, or omits the version to install.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { satisfies, toolchainProblems } from "./toolchain.mjs";

const root = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json")));
const wanted = manifest.packageManager.replace(/^pnpm@/, "").split("+")[0];

/** Runs the check with a stand-in `pnpm` that reports `version`. */
const check = (version, environment = {}) => {
  const bin = mkdtempSync(resolve(tmpdir(), "dx-toolchain-"));
  if (version !== undefined) {
    writeFileSync(
      resolve(bin, "pnpm"),
      `#!/bin/sh\necho ${JSON.stringify(version)}\n`,
    );
    chmodSync(resolve(bin, "pnpm"), 0o755);
  }
  return spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "toolchain.mjs")],
    {
      encoding: "utf8",
      env: {
        // The stand-in pnpm comes first; node's own directory supplies node.
        PATH: `${bin}:${dirname(process.execPath)}`,
        ...environment,
      },
    },
  );
};

describe("self-host toolchain check", () => {
  it("passes the pinned pnpm and a newer pnpm of the same major", () => {
    for (const version of [wanted, "12.99.0"]) {
      const result = check(version);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`pnpm ${version}`);
    }
  });

  it("fails another pnpm major in one line naming the version to install", () => {
    for (const version of ["10.34.9", "13.0.0", "9.15.9"]) {
      const result = check(version);
      expect(result.status).toBe(1);
      expect(result.stderr.trim().split("\n")).toEqual([
        `dx needs pnpm ${wanted}; this is ${version}. Run \`corepack enable\` (or install pnpm ${wanted}) and retry.`,
      ]);
    }
  });

  it("fails a lockfile setting overridden from the environment, and only when it differs", () => {
    for (const name of [
      "PNPM_CONFIG_AUTO_INSTALL_PEERS",
      "pnpm_config_auto_install_peers",
      "npm_config_auto_install_peers",
    ]) {
      const result = check(wanted, { [name]: "false" });
      expect(result.status).toBe(1);
      expect(result.stderr.trim().split("\n")).toEqual([
        `Unset ${name}: it changes "autoInstallPeers", which pnpm-lock.yaml records, so \`pnpm install --frozen-lockfile\` refuses the install.`,
      ]);
      expect(check(wanted, { [name]: "true" }).status).toBe(0);
    }
  });

  it("names an old Node.js and a missing pnpm", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "dx-toolchain-root-"));
    writeFileSync(
      resolve(fixture, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@12.14.0",
        engines: { node: ">=22.19.0", pnpm: ">=12.14.0 <13" },
      }),
    );
    // No pnpm-lock.yaml: a missing lockfile is pnpm's to report.
    expect(
      toolchainProblems({
        root: fixture,
        nodeVersion: "20.20.2",
        pnpmVersion: "",
        environment: {},
      }),
    ).toEqual([
      "dx needs Node.js >=22.19.0; this is 20.20.2. Install a newer Node.js and retry.",
      "dx needs pnpm 12.14.0; this is no pnpm. Run `corepack enable` (or install pnpm 12.14.0) and retry.",
    ]);
    expect(satisfies("22.19.0", ">=22.19.0")).toBe(true);
    expect(satisfies("22.18.9", ">=22.19.0")).toBe(false);
  });
});
