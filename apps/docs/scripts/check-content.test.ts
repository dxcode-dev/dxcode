import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("docs content checks", () => {
  it("accepts the checked-in source, links, and public-content boundary", () => {
    const script = fileURLToPath(
      new URL("./check-content.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docs source and internal links passed");
  });

  it.each([
    "TODO: finish this",
    "TBD",
    "Pending Track C integration",
    "This is not implemented.",
    "pre-release instructions",
    "external clean-room check",
  ])("rejects unfinished release content: %s", (contents) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "dx-docs-content-"));
    writeFileSync(resolve(fixture, "page.md"), contents);
    const script = fileURLToPath(
      new URL("./check-content.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, [script, "--root", fixture], {
      encoding: "utf8",
    });
    rmSync(fixture, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /unfinished content marker|obsolete release language/,
    );
  });

  it("typechecks through the workspace gate without generated Astro state", () => {
    const generatedDirectory = fileURLToPath(
      new URL("../.astro", import.meta.url),
    );
    rmSync(generatedDirectory, { recursive: true, force: true });

    const result = spawnSync(
      "pnpm",
      ["exec", "tsc", "-b", "--pretty", "false", "apps/docs"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(existsSync(generatedDirectory)).toBe(false);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });
});
