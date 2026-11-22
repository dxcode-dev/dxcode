import type { RunnerMachine } from "@dx/api";

const osName = (os: RunnerMachine["os"]) =>
  os === "macos" ? "macOS" : "Linux";

const archName = ({ os, arch }: RunnerMachine) =>
  os === "macos"
    ? arch === "aarch64"
      ? "Apple silicon"
      : "Intel"
    : arch === "aarch64"
      ? "Arm"
      : "x86-64";

/** A machine's platform, such as "macOS, Apple silicon". */
export const runnerPlatform = (runner: RunnerMachine) =>
  `${osName(runner.os)}, ${archName(runner)}`;

/** A machine's one-line description, such as "Online · macOS, Apple silicon". */
export const describeRunner = (runner: RunnerMachine) =>
  `${runner.online ? "Online" : "Offline"} · ${runnerPlatform(runner)}`;
