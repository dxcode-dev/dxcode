// The Mac Desktop's voxl for runners (github.com/tembo/voxl, MIT), pinned in
// deploy/runner/voxl.json: the upstream version and commit plus dx's patches
// (deploy/runner/voxl-patches, numbered by `patchLevel`), built once on a Mac
// and uploaded as an asset of a GitHub Release of the repository deploying
// (tag `voxl-v<version>-dx<patchLevel>`, or `voxl-v<version>` for the
// unpatched upstream; `GITHUB_REPOSITORY` in Actions, else the checkout's
// `origin`), never built in CI. A deploy downloads each pinned asset with the workflow's
// token (the repository is private), checks its SHA-256, and puts it beside
// the runner's dxd builds; production-package.mjs then serves it at
// /runner/<asset> and lists it in /runner/manifest.json as
// `voxl-darwin-<arch>`, where `dxd runner` looks for it.
//
// The Desktop's launcher (`dx`, apps/desktop), pinned the same way in
// deploy/runner/dx-desktop.json (tag `dx-desktop-v<version>`, built once with
// scripts/build-dx-desktop.sh), is served as `dx-desktop-darwin-<arch>`: the
// runner makes it ~/.dx/runner/dx.app, which starts voxl and holds the Mac's
// Screen Recording and Accessibility grants, so voxl updates keep them.
//
// To pin a new voxl: change the version, upstreamCommit, patches, or
// patchLevel, run the `voxl-runner-build.yml` workflow (or
// scripts/build-voxl-runner.sh on an Apple silicon Mac and upload its
// `voxl-darwin-arm64` to a prerelease of the tag it prints), then set the tag
// and each asset's sha256 here. A platform without an entry is skipped.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
export const VOXL_PIN = resolve(workspaceRoot, "deploy/runner/voxl.json");

export const DESKTOP_PIN = resolve(
  workspaceRoot,
  "deploy/runner/dx-desktop.json",
);

/**
 * The dx Mac app (apps/apple, the official variant), pinned in
 * deploy/apps/mac.json (tag `dx-mac-v<version>`, built and signed by the
 * mac-app-build.yml workflow): a DMG for the download button and a zip for
 * the one-line install, served at /runner/<asset>. Optional: without a pin,
 * dxcode.dev/apps says the download is coming.
 */
export const MAC_APP_PIN = resolve(workspaceRoot, "deploy/apps/mac.json");
export const MAC_APP_ASSETS = Object.freeze({
  "macos-aarch64-dmg": "dx-mac-arm64.dmg",
  "macos-aarch64-zip": "dx-mac-arm64.zip",
});
/** The launcher's release asset names, per runner platform (Apple silicon only). */
export const DESKTOP_ASSETS = Object.freeze({
  "macos-aarch64": "dx-desktop-darwin-arm64",
});

/** Release asset names `dxd runner` can use, per runner platform (Apple silicon only). */
export const VOXL_ASSETS = Object.freeze({
  "macos-aarch64": "voxl-darwin-arm64",
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const OWNER_REPO = /^[a-z0-9-]+\/[a-z0-9._-]+$/i;

/** The GitHub repository whose release holds voxl: this checkout's. */
export const deployingRepository = () => {
  const fromActions = process.env.GITHUB_REPOSITORY?.trim();
  if (fromActions && OWNER_REPO.test(fromActions)) return fromActions;
  try {
    const origin = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).trim();
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin);
    return match && OWNER_REPO.test(match[1]) ? match[1] : undefined;
  } catch {
    return undefined;
  }
};

export const readVoxlPin = (path = VOXL_PIN) => {
  const pin = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof pin.version !== "string" ||
    typeof pin.tag !== "string" ||
    typeof pin.assets !== "object"
  )
    throw new Error(`${path}: needs version, tag, and assets.`);
  if (!/^[0-9a-f]{40}$/.test(pin.upstreamCommit ?? ""))
    throw new Error(
      `${path}: upstreamCommit must be tembo/voxl's full commit SHA.`,
    );
  if (!Number.isInteger(pin.patchLevel) || pin.patchLevel < 0)
    throw new Error(`${path}: patchLevel must be a whole number.`);
  const tag = new RegExp(
    `^voxl-v${pin.version.replaceAll(".", "\\.")}(?:-dx[1-9][0-9]*)?$`,
  );
  if (!tag.test(pin.tag))
    throw new Error(
      `${path}: tag must be voxl-v${pin.version} or voxl-v${pin.version}-dx<n>.`,
    );
  for (const [platform, entry] of Object.entries(pin.assets)) {
    if (VOXL_ASSETS[platform] !== entry?.asset)
      throw new Error(
        `${path}: ${platform} must name the asset ${VOXL_ASSETS[platform] ?? "(no such platform)"}.`,
      );
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? ""))
      throw new Error(`${path}: ${platform} needs a sha256.`);
  }
  return pin;
};

export const readDesktopPin = (path = DESKTOP_PIN) => {
  const pin = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof pin.version !== "string" ||
    typeof pin.tag !== "string" ||
    typeof pin.assets !== "object"
  )
    throw new Error(`${path}: needs version, tag, and assets.`);
  if (pin.tag !== `dx-desktop-v${pin.version}`)
    throw new Error(`${path}: tag must be dx-desktop-v${pin.version}.`);
  for (const [platform, entry] of Object.entries(pin.assets)) {
    if (DESKTOP_ASSETS[platform] !== entry?.asset)
      throw new Error(
        `${path}: ${platform} must name the asset ${DESKTOP_ASSETS[platform] ?? "(no such platform)"}.`,
      );
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? ""))
      throw new Error(`${path}: ${platform} needs a sha256.`);
  }
  return pin;
};

export const readMacAppPin = (path = MAC_APP_PIN) => {
  const pin = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof pin.version !== "string" ||
    typeof pin.tag !== "string" ||
    typeof pin.assets !== "object"
  )
    throw new Error(`${path}: needs version, tag, and assets.`);
  if (pin.tag !== `dx-mac-v${pin.version}`)
    throw new Error(`${path}: tag must be dx-mac-v${pin.version}.`);
  for (const [platform, entry] of Object.entries(pin.assets)) {
    if (MAC_APP_ASSETS[platform] !== entry?.asset)
      throw new Error(
        `${path}: ${platform} must name the asset ${MAC_APP_ASSETS[platform] ?? "(no such platform)"}.`,
      );
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? ""))
      throw new Error(`${path}: ${platform} needs a sha256.`);
  }
  return pin;
};

/** Writes the pinned Mac app's DMG and zip, when deploy/apps/mac.json exists. */
export const fetchPinnedMacApp = ({ pinPath = MAC_APP_PIN, ...options }) =>
  existsSync(pinPath)
    ? fetchPinned({
        ...options,
        pin: readMacAppPin(pinPath),
        pinPath,
        name: "dx-mac",
      })
    : Promise.resolve([]);

/**
 * Writes each pinned voxl to `<directory>/<asset>`. A missing pin entry, a
 * missing token, or a failed download leaves that platform out with a
 * warning (runners then use a local build), or fails with `required` (the
 * release, which must publish every runner asset); a SHA-256 mismatch
 * always fails, since the pin and the release disagree.
 */
export const fetchPinnedVoxl = ({ pinPath = VOXL_PIN, ...options }) =>
  fetchPinned({ ...options, pin: readVoxlPin(pinPath), pinPath, name: "voxl" });

/**
 * Writes the pinned Desktop launcher to `<directory>/<asset>`, as
 * {@link fetchPinnedVoxl} does voxl. Without it a runner runs voxl itself,
 * whose grants each voxl update loses.
 */
export const fetchPinnedDesktop = ({ pinPath = DESKTOP_PIN, ...options }) =>
  fetchPinned({
    ...options,
    pin: readDesktopPin(pinPath),
    pinPath,
    name: "dx-desktop",
  });

const fetchPinned = async ({
  directory,
  token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim(),
  cacheDirectory,
  pin,
  pinPath,
  name,
  repository = deployingRepository(),
  fetchImpl = fetch,
  required = false,
  warn: warnOnly = console.warn,
}) => {
  const warn = (message) => {
    if (required) throw new Error(message.replace(/; skipping .*$/, "."));
    warnOnly(message);
  };
  const written = [];
  const entries = Object.entries(pin.assets);
  if (entries.length === 0) {
    warn(`runner: ${pinPath} pins no ${name} asset.`);
    return written;
  }
  let release;
  for (const [platform, { asset, sha256: expected }] of entries) {
    const cached =
      cacheDirectory && resolve(cacheDirectory, name, expected, asset);
    let bytes = cached && existsSync(cached) ? readFileSync(cached) : undefined;
    if (bytes === undefined) {
      if (!token || !repository) {
        warn(
          `runner: no ${token ? "GitHub repository" : "GH_TOKEN or GITHUB_TOKEN"} to download ${name} ${pin.tag} from; skipping ${asset}.`,
        );
        continue;
      }
      const headers = {
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      };
      try {
        release ??= await (async () => {
          const response = await fetchImpl(
            `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(pin.tag)}`,
            { headers: { ...headers, accept: "application/vnd.github+json" } },
          );
          if (!response.ok)
            throw new Error(`release ${pin.tag} answered ${response.status}`);
          return response.json();
        })();
        const entry = release.assets?.find((a) => a.name === asset);
        if (entry === undefined)
          throw new Error(`release ${pin.tag} has no asset ${asset}`);
        const response = await fetchImpl(entry.url, {
          headers: { ...headers, accept: "application/octet-stream" },
        });
        if (!response.ok)
          throw new Error(`asset ${asset} answered ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (cause) {
        warn(
          `runner: ${name} ${asset} not downloaded (${cause instanceof Error ? cause.message : cause}); skipping it.`,
        );
        continue;
      }
    }
    const got = sha256(bytes);
    if (got !== expected)
      throw new Error(
        `${name} ${asset} from ${pin.tag} has SHA-256 ${got}, but ${pinPath} pins ${expected}.`,
      );
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, asset), bytes, { mode: 0o755 });
    if (cached && !existsSync(cached)) {
      mkdirSync(dirname(cached), { recursive: true });
      copyFileSync(resolve(directory, asset), cached);
    }
    written.push({ platform, asset, sha256: got });
  }
  return written;
};

// The release job: `node scripts/runner-voxl.mjs --out <dir>` writes the
// pinned voxl, launcher, and Mac app with `<asset>.sha256` beside each, and fails
// unless every pinned asset downloads and matches its pin. `--voxl-pin` and
// `--desktop-pin` read the pins from other files, such as the released
// commit's.
if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (name) =>
    args.includes(name)
      ? resolve(args[args.indexOf(name) + 1] ?? "")
      : undefined;
  const out = value("--out");
  if (out === undefined)
    throw new Error(
      "Usage: node scripts/runner-voxl.mjs --out <dir> [--voxl-pin <file>] [--desktop-pin <file>] [--mac-app-pin <file>]",
    );
  const options = { directory: out, required: true };
  for (const { asset, sha256: hash } of [
    ...(await fetchPinnedVoxl({ ...options, pinPath: value("--voxl-pin") })),
    ...(await fetchPinnedDesktop({
      ...options,
      pinPath: value("--desktop-pin"),
    })),
    ...(await fetchPinnedMacApp({
      ...options,
      pinPath: value("--mac-app-pin"),
    })),
  ]) {
    writeFileSync(resolve(out, `${asset}.sha256`), `${hash}  ${asset}\n`);
    console.log(`${asset}: ${hash}`);
  }
}
