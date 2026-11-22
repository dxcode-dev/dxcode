import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

// The one build path for every dxd binary: local builds, branch and staging
// deployments (which serve the Linux x64 guest binary from their Worker), the
// CI matrix, and published release assets. No Docker or C toolchain.
//
//   node scripts/build-dxd.mjs                 # the x64 guest binary
//   node scripts/build-dxd.mjs --target aarch64-unknown-linux-musl
//   node scripts/build-dxd.mjs --all           # every release target
//   node scripts/build-dxd.mjs --runner --assets <dir>
//   node scripts/build-dxd.mjs --with-mac    # the guest and the Mac runner
//                                              # every runner host (macOS + Linux)
//                                              # + <dir>/manifest.json for /runner/
//   node scripts/build-dxd.mjs --target <t> --assets <dir>
//                                              # release asset + <asset>.sha256
//
// dxd runs on Linux only (x64 and arm64, static musl). Every target links
// through `cargo zigbuild` (zig as the C compiler and linker), so the same
// command works on Linux, macOS, and Windows hosts.
// Output: .dx/alchemy/dxd/<target>/dxd plus its sha256. The Linux x64
// guest binary is also copied to .dx/alchemy/dxd-linux-x64/dxd for the
// release and self-host tooling.
const workspaceRoot = resolve(import.meta.dirname, "..");
const manifest = resolve(workspaceRoot, "apps/dxd/Cargo.toml");
const outputRoot = resolve(workspaceRoot, ".dx/alchemy/dxd");

export const RELEASE_TARGETS = Object.freeze({
  "x86_64-unknown-linux-musl": { asset: "dxd-linux-x64" },
  "aarch64-unknown-linux-musl": { asset: "dxd-linux-arm64" },
});

/**
 * Runner hosts: a person's own Mac, built here without the macOS SDK (dxd
 * links only libSystem). zig's linker adds the ad-hoc signature Apple
 * silicon requires. Linux runners use the release targets above.
 */
export const RUNNER_TARGETS = Object.freeze({
  // Apple silicon only: Intel Macs are not supported runners.
  "aarch64-apple-darwin": { asset: "dxd-darwin-arm64" },
});

const BUILD_TARGETS = Object.freeze({ ...RELEASE_TARGETS, ...RUNNER_TARGETS });

/**
 * A runner machine's platform (`<os>-<arch>` as Rust's std names them, the
 * key `dxd runner` looks up in Core's `/runner/manifest.json`) and the
 * target built for it. One dxd binary serves a machine: the supervisor and
 * every Thread's daemon.
 */
export const RUNNER_PLATFORMS = Object.freeze({
  "macos-aarch64": "aarch64-apple-darwin",
  "linux-x86_64": "x86_64-unknown-linux-musl",
  "linux-aarch64": "aarch64-unknown-linux-musl",
});

/** The crate version every runner build reports (`dxd runner version`). */
export const dxdVersion = () =>
  readFileSync(manifest, "utf8").match(
    /^version = "([0-9]+\.[0-9]+\.[0-9]+)"/m,
  )[1];

/**
 * `/runner/manifest.json`: per platform, the path Core serves the binary at
 * and its SHA-256. `results` are `buildTarget` results for every platform.
 * The Mac Desktop's voxl is not built here (it needs a Mac and changes only
 * with its own version): deploys download the build pinned in
 * deploy/runner/voxl.json (scripts/runner-voxl.mjs) and
 * production-package.mjs lists it as `voxl-darwin-<arch>`. A CI-built voxl
 * would replace that download, not this function.
 */
export const runnerManifest = (results) => ({
  version: dxdVersion(),
  assets: Object.fromEntries(
    Object.entries(RUNNER_PLATFORMS).map(([platform, target]) => {
      const result = results.find((r) => r.target === target);
      if (result === undefined)
        throw new Error(`No runner build for ${target}.`);
      return [
        platform,
        {
          path: `/runner/${BUILD_TARGETS[target].asset}`,
          sha256: result.sha256,
        },
      ];
    }),
  ),
});

/** The oldest macOS a runner's dxd starts on. */
const MACOS_DEPLOYMENT_TARGET = "12.0";

/** The E2B guest binary every hosted deployment serves at `/dxd`. */
export const GUEST_TARGET = "x86_64-unknown-linux-musl";

const has = (command, args) =>
  spawnSync(command, args, { stdio: "ignore" }).status === 0;

// zig links musl by compiling its libc, holding one open cache manifest per
// source file (over 1,100) at once. It raises its soft open-file limit to the
// hard limit itself, but containers, Orbs included, start every process at a
// hard limit of 1024, and zig then fails with ProcessFdQuotaExceeded. Raise
// this process's hard limit, which cargo and zig inherit, where passwordless
// sudo allows it (every Orb). Agent commands enter an Orb outside its
// entrypoint, so the image cannot raise the limit for them.
const OPEN_FILE_LIMIT = 524288;
const raiseOpenFileLimit = () => {
  if (process.platform !== "linux") return;
  let limits;
  try {
    limits = readFileSync("/proc/self/limits", "utf8");
  } catch {
    return;
  }
  const [, soft, hard] = limits.match(/^Max open files\s+(\S+)\s+(\S+)/m) ?? [];
  if (hard === undefined || hard === "unlimited") return;
  if (Number(hard) >= OPEN_FILE_LIMIT) return;
  const raised = has("sudo", [
    "-n",
    "prlimit",
    "--pid",
    String(process.pid),
    `--nofile=${soft}:${OPEN_FILE_LIMIT}`,
  ]);
  if (!raised && Number(hard) < 4096)
    console.warn(
      `The open-file hard limit is ${hard}; zig needs more to link dxd. Raise it (as root: ulimit -Hn ${OPEN_FILE_LIMIT}) if the build fails with ProcessFdQuotaExceeded.`,
    );
};

/**
 * Build one target. Deployments pass their own clean `targetDirectory` and
 * isolated `environment`; the binary then stays in that directory.
 */
export const buildTarget = (target, options = {}) => {
  if (BUILD_TARGETS[target] === undefined)
    throw new Error(`${target} is not a dxd build target.`);
  if (!has("cargo-zigbuild", ["--version"]))
    throw new Error(
      "cargo-zigbuild is required: cargo install --locked cargo-zigbuild",
    );
  if (
    !has("zig", ["version"]) &&
    !has("python3", ["-m", "ziglang", "version"]) &&
    !has("python", ["-m", "ziglang", "version"])
  )
    throw new Error("zig is required: pip install ziglang  (or install zig)");
  const installed = spawnSync("rustup", ["target", "list", "--installed"], {
    encoding: "utf8",
  });
  if (installed.status === 0 && !installed.stdout.includes(target))
    execFileSync("rustup", ["target", "add", target], { stdio: "inherit" });
  const targetDirectory =
    options.targetDirectory ?? resolve(outputRoot, "target");
  mkdirSync(targetDirectory, { recursive: true });
  raiseOpenFileLimit();
  const build = spawnSync(
    "cargo",
    [
      "zigbuild",
      "--release",
      "--locked",
      "--manifest-path",
      manifest,
      "--target",
      target,
    ],
    {
      cwd: workspaceRoot,
      env: {
        ...(options.environment ?? process.env),
        CARGO_TARGET_DIR: targetDirectory,
        ...(target.endsWith("-apple-darwin")
          ? { MACOSX_DEPLOYMENT_TARGET: MACOS_DEPLOYMENT_TARGET }
          : {}),
      },
      stdio: "inherit",
    },
  );
  if (build.error) throw build.error;
  if (build.status !== 0)
    throw new Error(`The dxd build for ${target} failed.`);
  const binary = resolve(targetDirectory, target, "release", "dxd");
  if (!existsSync(binary)) throw new Error("The build produced no dxd binary.");
  const sha256 = createHash("sha256")
    .update(readFileSync(binary))
    .digest("hex");
  if (options.targetDirectory !== undefined) return { target, binary, sha256 };
  const destinationDirectory = resolve(outputRoot, target);
  mkdirSync(destinationDirectory, { recursive: true });
  const destination = resolve(destinationDirectory, "dxd");
  copyFileSync(binary, destination);
  if (target === "x86_64-unknown-linux-musl") {
    // The release and self-host tooling read the guest binary from here.
    const legacy = resolve(workspaceRoot, ".dx/alchemy/dxd-linux-x64");
    mkdirSync(legacy, { recursive: true });
    copyFileSync(binary, resolve(legacy, "dxd"));
  }
  return { target, binary: destination, sha256 };
};

/** Copy a built binary to `<directory>/<asset>` with `<asset>.sha256`. */
export const writeReleaseAsset = (result, directory) => {
  const { asset } = BUILD_TARGETS[result.target];
  mkdirSync(directory, { recursive: true });
  copyFileSync(result.binary, resolve(directory, asset));
  writeFileSync(
    resolve(directory, `${asset}.sha256`),
    `${result.sha256}  ${asset}\n`,
  );
  return asset;
};

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  // --with-mac: the guest binary and the Apple silicon runner build, so a
  // change that breaks macOS (a Linux-only call) fails before it merges.
  const targets = args.includes("--with-mac")
    ? [GUEST_TARGET, "aarch64-apple-darwin"]
    : args.includes("--all")
      ? Object.keys(RELEASE_TARGETS)
      : args.includes("--runner")
        ? Object.keys(BUILD_TARGETS)
        : [
            args.includes("--target")
              ? args[args.indexOf("--target") + 1]
              : GUEST_TARGET,
          ].filter(
            (target) => target !== undefined && !target.startsWith("--"),
          );
  const assets = args.includes("--assets")
    ? resolve(args[args.indexOf("--assets") + 1] ?? "")
    : undefined;
  const results = [];
  for (const target of targets) {
    const result = buildTarget(target);
    results.push(result);
    console.log(`${result.target}: ${result.binary}\nsha256: ${result.sha256}`);
    if (assets !== undefined)
      console.log(`asset: ${writeReleaseAsset(result, assets)}`);
  }
  if (args.includes("--runner") && assets !== undefined) {
    writeFileSync(
      resolve(assets, "manifest.json"),
      `${JSON.stringify(runnerManifest(results), null, 2)}\n`,
    );
    console.log(`runner manifest: ${resolve(assets, "manifest.json")}`);
  }
}
