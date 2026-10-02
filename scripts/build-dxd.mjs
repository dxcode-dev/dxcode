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

/** The E2B guest binary every hosted deployment serves at `/dxd`. */
export const GUEST_TARGET = "x86_64-unknown-linux-musl";

const has = (command, args) =>
  spawnSync(command, args, { stdio: "ignore" }).status === 0;

/**
 * Build one target. Deployments pass their own clean `targetDirectory` and
 * isolated `environment`; the binary then stays in that directory.
 */
export const buildTarget = (target, options = {}) => {
  if (RELEASE_TARGETS[target] === undefined)
    throw new Error(`${target} is not a dxd release target.`);
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
  const { asset } = RELEASE_TARGETS[result.target];
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
  const targets = args.includes("--all")
    ? Object.keys(RELEASE_TARGETS)
    : [
        args.includes("--target")
          ? args[args.indexOf("--target") + 1]
          : GUEST_TARGET,
      ].filter((target) => target !== undefined && !target.startsWith("--"));
  const assets = args.includes("--assets")
    ? resolve(args[args.indexOf("--assets") + 1] ?? "")
    : undefined;
  for (const target of targets) {
    const result = buildTarget(target);
    console.log(`${result.target}: ${result.binary}\nsha256: ${result.sha256}`);
    if (assets !== undefined)
      console.log(`asset: ${writeReleaseAsset(result, assets)}`);
  }
}
