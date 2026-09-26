import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Builds the Linux x64 dxd inside a container so self-host operators on
// macOS/Windows can produce the exact binary the deploy packages and
// checksums. Output: .dx/alchemy/dxd-linux-x64/dxd
// Usage: node scripts/build-dxd-linux.mjs
const workspaceRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(workspaceRoot, ".dx/alchemy/dxd-linux-x64");
const targetDirectory = `${outputDirectory}/target`;
const cargoCache = `${outputDirectory}/cargo`;

const image = "rust:1.89.0-bookworm";
mkdirSync(targetDirectory, { recursive: true });
mkdirSync(cargoCache, { recursive: true });

const nativeLinuxX64 = process.platform === "linux" && process.arch === "x64";
const docker = nativeLinuxX64
  ? undefined
  : spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
    });
if (docker && (docker.error || docker.status !== 0))
  throw new Error("Docker is required to build a Linux dxd on this host.");

const build = nativeLinuxX64
  ? spawnSync(
      "cargo",
      [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        "apps/dxd/Cargo.toml",
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
        stdio: "inherit",
      },
    )
  : spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "-v",
        `${workspaceRoot}:/work:ro`,
        "-v",
        `${targetDirectory}:/target`,
        "-v",
        `${cargoCache}:/cargo`,
        "-u",
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        "-e",
        "CARGO_TARGET_DIR=/target",
        "-e",
        "CARGO_HOME=/cargo",
        "-e",
        "CARGO_TERM_COLOR=never",
        image,
        "cargo",
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        "/work/apps/dxd/Cargo.toml",
      ],
      { stdio: "inherit" },
    );
if (build.error) throw build.error;
if (build.status !== 0) throw new Error("The dxd build failed.");

const binary = resolve(targetDirectory, "release/dxd");
if (!existsSync(binary)) throw new Error("The build produced no dxd binary.");
const contents = readFileSync(binary);
if (!contents.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
  throw new Error("The produced dxd is not an ELF binary.");
const checksum = createHash("sha256").update(contents).digest("hex");
execFileSync("cp", [binary, resolve(outputDirectory, "dxd")]);
console.log(`dxd linux-x64: .dx/alchemy/dxd-linux-x64/dxd`);
console.log(`sha256: ${checksum}`);
console.log(
  `\nAdd to deploy.selfhost.json:\n  "dxdBinary": ".dx/alchemy/dxd-linux-x64/dxd"`,
);
