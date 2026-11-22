import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

/**
 * The runner assets a release publishes beside `dxd-linux-x64` and records
 * in deploy/RELEASE.json's `runner` object (asset name to `{ url, sha256 }`):
 * dxd for the other runner machines, and the Mac Desktop's voxl and its
 * launcher. A Linux x64 runner uses the release's own `dxd-linux-x64`.
 * Releases before these assets have no `runner` object.
 */
export const RUNNER_RELEASE_ASSETS = Object.freeze([
  "dxd-darwin-arm64",
  "dxd-linux-arm64",
  "voxl-darwin-arm64",
  "dx-desktop-darwin-arm64",
]);

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const validRunnerRecord = (release) => {
  const runner = release.runner;
  if (runner === undefined) return true;
  if (typeof runner !== "object" || runner === null || Array.isArray(runner))
    return false;
  const names = Object.keys(runner).sort();
  return (
    JSON.stringify(names) ===
      JSON.stringify([...RUNNER_RELEASE_ASSETS].sort()) &&
    names.every((asset) => {
      const entry = runner[asset];
      if (
        typeof entry?.url !== "string" ||
        !entry.url.startsWith("https://") ||
        !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
      )
        return false;
      // The asset sits on the same release as dxd, under its own name.
      return (
        entry.url ===
        release.url.replace(/\/dxd-linux-x64$/, `/${encodeURIComponent(asset)}`)
      );
    })
  );
};

export const loadDxdRelease = (root = process.cwd()) => {
  const release = JSON.parse(
    readFileSync(resolve(root, "deploy/RELEASE.json"), "utf8"),
  );
  if (
    release?.version !== 1 ||
    typeof release.release !== "string" ||
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.release) ||
    typeof release.dxd !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.dxd) ||
    release.platform !== "linux-x64" ||
    release.asset !== "dxd-linux-x64" ||
    typeof release.url !== "string" ||
    !release.url.startsWith("https://") ||
    !/^[a-f0-9]{64}$/.test(release.sha256 ?? "")
  )
    throw new Error(
      "deploy/RELEASE.json does not describe one exact Linux x64 dxd asset.",
    );
  if (!validRunnerRecord(release))
    throw new Error(
      `deploy/RELEASE.json's runner assets must be exactly ${RUNNER_RELEASE_ASSETS.join(", ")}, each with an https URL on the dxd release and a SHA-256.`,
    );
  // Core pins the dxd version it was built with; a guest must never get an
  // older daemon than the Core that manages it. `release` is the product
  // release tag that carries the asset; `dxd` is the daemon version inside it.
  const manifest = resolve(root, "apps/dxd/Cargo.toml");
  const built = existsSync(manifest)
    ? readFileSync(manifest, "utf8").match(/^version = "([^"]+)"$/m)?.[1]
    : undefined;
  if (built !== undefined && release.dxd !== built)
    throw new Error(
      `deploy/RELEASE.json names dxd ${release.dxd}, but this revision is dxd ${built}. Publish a release asset built from dxd ${built} and record it in deploy/RELEASE.json first. No deployment changes were made.`,
    );
  return Object.freeze(release);
};

const githubReleaseAsset = (release) => {
  const url = new URL(release.url);
  const match = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/,
  );
  if (url.hostname !== "github.com" || match === null) return undefined;
  const [, owner, repository, tag, asset] = match.map((part) =>
    decodeURIComponent(part),
  );
  if (tag !== release.release || asset !== release.asset)
    throw new Error(
      `The ${release.asset} GitHub release URL does not match its metadata.`,
    );
  return { owner, repository, tag, asset };
};

const githubHeaders = (token, accept = "application/vnd.github+json") => ({
  Accept: accept,
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

const responseBytes = async (response, release) => {
  if (!response.ok)
    throw new Error(
      `Could not download the ${release.asset} ${release.release} release asset (${response.status}). No deployment changes were made.`,
    );
  return Buffer.from(await response.arrayBuffer());
};

export const downloadDxdRelease = async (
  release,
  { fetcher = fetch, githubToken } = {},
) => {
  const token = githubToken?.trim();
  const githubAsset = githubReleaseAsset(release);
  if (!token || githubAsset === undefined)
    return responseBytes(
      await fetcher(release.url, { redirect: "follow" }),
      release,
    );

  const { owner, repository, tag, asset } = githubAsset;
  const releaseResponse = await fetcher(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: githubHeaders(token) },
  );
  if (!releaseResponse.ok)
    throw new Error(
      `Could not resolve the private ${release.release} release (${releaseResponse.status}). No deployment changes were made.`,
    );
  const matchingAsset = (await releaseResponse.json()).assets?.find(
    (candidate) => candidate?.name === asset,
  );
  if (
    typeof matchingAsset?.url !== "string" ||
    !matchingAsset.url.startsWith(
      `https://api.github.com/repos/${owner}/${repository}/releases/assets/`,
    )
  )
    throw new Error(
      `The private ${release.release} release has no ${asset} asset. No deployment changes were made.`,
    );
  return responseBytes(
    await fetcher(matchingAsset.url, {
      headers: githubHeaders(token, "application/octet-stream"),
      redirect: "follow",
    }),
    release,
  );
};

export const verifyDxdBytes = (bytes, release) => {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== release.sha256)
    throw new Error(
      `dxd checksum mismatch: expected ${release.sha256}, received ${actual}. No deployment changes were made.`,
    );
  return actual;
};

/**
 * The runner assets a self-hosted deployment serves at /runner, from the
 * release deploy/RELEASE.json records: `guestBinary` (the release's
 * `dxd-linux-x64`) for Linux x64 runners, and each recorded runner asset,
 * downloaded and checked against its SHA-256, written to `directory`.
 * Returns the directory, or undefined for a release that records no runner
 * assets (the deployment then serves no /runner). A failed download or a
 * checksum mismatch fails before any deployment change.
 */
export const downloadRunnerRelease = async (
  release,
  { directory, guestBinary, fetcher = fetch, githubToken } = {},
) => {
  if (release.runner === undefined) return undefined;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  copyFileSync(guestBinary, resolve(directory, "dxd-linux-x64"));
  for (const asset of RUNNER_RELEASE_ASSETS) {
    const { url, sha256 } = release.runner[asset];
    const bytes = await downloadDxdRelease(
      { release: release.release, asset, url },
      { fetcher, githubToken },
    );
    const actual = sha256Hex(bytes);
    if (actual !== sha256)
      throw new Error(
        `${asset} checksum mismatch: expected ${sha256}, received ${actual}. No deployment changes were made.`,
      );
    writeFileSync(resolve(directory, asset), bytes, { mode: 0o700 });
  }
  return directory;
};
