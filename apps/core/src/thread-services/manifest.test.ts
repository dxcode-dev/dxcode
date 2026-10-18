import { describe, expect, it } from "vitest";
import {
  MAX_SERVICE_COMMAND_BYTES,
  MAX_SERVICE_CWD_BYTES,
  MAX_SERVICE_ENV,
  MAX_SERVICE_ENV_VALUE_BYTES,
  MAX_SERVICES,
  parseServicesManifest,
} from "./manifest.js";

describe("parseServicesManifest", () => {
  it("reads declared services with their defaults", () => {
    expect(
      parseServicesManifest(`
services:
  web:
    command: pnpm dev --port $PORT
    port: 5173
    cwd: apps/web
    env: { MODE: dev, WORKERS: 2, DEBUG: true }
  api:
    command: node server.js
    port: 8787
`),
    ).toEqual([
      {
        name: "web",
        command: "pnpm dev --port $PORT",
        port: 5173,
        cwd: "apps/web",
        env: { MODE: "dev", WORKERS: "2", DEBUG: "true" },
      },
      { name: "api", command: "node server.js", port: 8787, env: {} },
    ]);
  });

  it.each([
    ["invalid YAML", "services: [unclosed"],
    ["no services key", "web: { command: x, port: 1 }"],
    [
      "an unknown field",
      "services:\n  web: { command: x, port: 3000, restart: always }",
    ],
    ["an uppercase name", "services:\n  Web: { command: x, port: 3000 }"],
    [
      "a name starting with a hyphen",
      "services:\n  -web: { command: x, port: 3000 }",
    ],
    ["an empty command", "services:\n  web: { command: '  ', port: 3000 }"],
    ["a missing port", "services:\n  web: { command: x }"],
    ["port zero", "services:\n  web: { command: x, port: 0 }"],
    ["a port above 65535", "services:\n  web: { command: x, port: 70000 }"],
    ["a fractional port", "services:\n  web: { command: x, port: 80.5 }"],
    [
      "the Desktop gateway port",
      "services:\n  web: { command: x, port: 5900 }",
    ],
    [
      "Chromium's DevTools port",
      "services:\n  web: { command: x, port: 9222 }",
    ],
    [
      "two services on one port",
      "services:\n  a: { command: x, port: 3000 }\n  b: { command: y, port: 3000 }",
    ],
    [
      "an absolute cwd",
      "services:\n  web: { command: x, port: 3000, cwd: /etc }",
    ],
    [
      "a cwd escaping the repository",
      "services:\n  web: { command: x, port: 3000, cwd: a/../../b }",
    ],
    [
      "an env override of PORT",
      "services:\n  web: { command: x, port: 3000, env: { PORT: 1 } }",
    ],
    [
      "an invalid env name",
      "services:\n  web: { command: x, port: 3000, env: { 1X: a } }",
    ],
    [
      "a nested env value",
      "services:\n  web: { command: x, port: 3000, env: { A: { b: c } } }",
    ],
    [
      "YAML aliases",
      "base: &b { command: x, port: 3000 }\nservices:\n  web: *b",
    ],
  ])("rejects %s", (_case, text) => {
    expect(parseServicesManifest(text)).toBeUndefined();
  });

  // dxd measures UTF-8 bytes; "é" is one UTF-16 unit and two bytes.
  const env = (count: number, value: string) =>
    `{ ${Array.from({ length: count }, (_, index) => `V${index}: ${JSON.stringify(value)}`).join(", ")} }`;

  it("accepts every bound dxd accepts, measured in bytes", () => {
    const [service] =
      parseServicesManifest(`services:
  web:
    command: ${JSON.stringify("x".repeat(MAX_SERVICE_COMMAND_BYTES))}
    port: 3000
    cwd: ${JSON.stringify("é".repeat(MAX_SERVICE_CWD_BYTES / 2))}
    env: ${env(MAX_SERVICE_ENV, "é".repeat(MAX_SERVICE_ENV_VALUE_BYTES / 2))}
`) ?? [];
    expect(Object.keys(service?.env ?? {})).toHaveLength(MAX_SERVICE_ENV);
  });

  it.each([
    ["more env variables than dxd accepts", env(MAX_SERVICE_ENV + 1, "1"), ""],
    [
      "an env value beyond dxd's byte bound",
      env(1, "é".repeat(MAX_SERVICE_ENV_VALUE_BYTES / 2 + 1)),
      "",
    ],
    ["a NUL in an env value", env(1, "a\0b"), ""],
    [
      "a command beyond dxd's byte bound",
      "{}",
      "é".repeat(MAX_SERVICE_COMMAND_BYTES / 2 + 1),
    ],
    ["a command Rust trims to nothing", "{}", "\u0085"],
  ])("rejects %s", (_case, environment, command) => {
    expect(
      parseServicesManifest(
        `services:\n  web: { command: ${JSON.stringify(command || "x")}, port: 3000, env: ${environment} }`,
      ),
    ).toBeUndefined();
  });

  it("rejects a cwd beyond dxd's byte bound", () => {
    expect(
      parseServicesManifest(
        `services:\n  web: { command: x, port: 3000, cwd: ${JSON.stringify("é".repeat(MAX_SERVICE_CWD_BYTES / 2 + 1))} }`,
      ),
    ).toBeUndefined();
  });

  it("rejects more services than the daemon accepts", () => {
    const services = Array.from(
      { length: MAX_SERVICES + 1 },
      (_, index) => `  s${index}: { command: x, port: ${3000 + index} }`,
    ).join("\n");
    expect(parseServicesManifest(`services:\n${services}`)).toBeUndefined();
  });
});
