import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    throw new Error("The dxd GitHub release URL does not match its metadata.");
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
      `Could not download the dxd ${release.release} release asset (${response.status}). No deployment changes were made.`,
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
      `Could not resolve the private dxd ${release.release} release (${releaseResponse.status}). No deployment changes were made.`,
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
      `The private dxd ${release.release} release has no ${asset} asset. No deployment changes were made.`,
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
