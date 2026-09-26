import { EnvironmentVariableName } from "@dx/domain";
import { Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DXD_MAX_ENVIRONMENT_REQUEST_FRAME_BYTES,
  DXD_MAX_REQUEST_FRAME_BYTES,
  DxdEnvironmentActivateOperation,
} from "../../execution/dxd/protocol.js";
import { environmentActivationOperation } from "./activation.js";
import type { ExecutionEnvironmentSnapshot } from "./execution.js";

const snapshot = (
  values: ReadonlyArray<readonly [string, string]>,
): ExecutionEnvironmentSnapshot => ({
  revision: {
    personal: { targetId: "user", revision: 0 },
    project: { targetId: "project", revision: 0 },
    workspace: { targetId: null, revision: 0 },
  },
  values: values.map(([name, value]) => ({
    reference: {
      version: 1,
      kind: "environment-variable",
      id: `env_${name}` as never,
    },
    name: Schema.decodeUnknownSync(EnvironmentVariableName)(name),
    kind: "variable",
    value: Redacted.make(value),
    source: "personal",
  })),
});

describe("resident environment activation", () => {
  it("sorts and canonically encodes one point-in-time Core snapshot", () => {
    expect(
      environmentActivationOperation(
        snapshot([
          ["ZED", "line\nquote'\u{1f642}"],
          ["ALPHA", "plain"],
        ]),
        7,
      ),
    ).toEqual({
      operation: "environment.activate",
      generation: 7,
      git: {
        authorName: "dxcodeagent",
        authorEmail: "agent@dxcode.dev",
        threadUrl:
          "https://dx.example.test/threads/thr_00000000-0000-4000-8000-000000000000",
        signingEnabled: false,
      },
      entries: [
        { name: "ALPHA", valueBase64Url: "cGxhaW4" },
        {
          name: "ZED",
          valueBase64Url: "bGluZQpxdW90ZSfwn5mC",
        },
      ],
    });
  });

  it("excludes legacy runtime-owned socket variables before daemon validation", () => {
    expect(
      environmentActivationOperation(
        snapshot([
          ["DX_SOURCE_COMMAND_SOCKET", "/tmp/legacy.sock"],
          ["SAFE_VALUE", "kept"],
        ]),
        8,
      ).entries,
    ).toEqual([{ name: "SAFE_VALUE", valueBase64Url: "a2VwdA" }]);
  });

  it("supports 0 and 300 entries and rejects 301 or invalid generations", () => {
    expect(environmentActivationOperation(snapshot([]), 1).entries).toEqual([]);
    const maximum = Array.from(
      { length: 300 },
      (_, index) => [`VALUE_${String(index).padStart(3, "0")}`, "x"] as const,
    );
    expect(
      environmentActivationOperation(snapshot(maximum), 2).entries,
    ).toHaveLength(300);
    expect(() =>
      environmentActivationOperation(
        snapshot([...maximum, ["VALUE_300", "x"]]),
        3,
      ),
    ).toThrow();
    expect(() => environmentActivationOperation(snapshot([]), 0)).toThrow();
  });

  it("keeps the environment request exception distinct from ordinary requests", () => {
    expect(DXD_MAX_REQUEST_FRAME_BYTES).toBe(2 * 1_024 * 1_024);
    expect(DXD_MAX_ENVIRONMENT_REQUEST_FRAME_BYTES).toBe(14 * 1_024 * 1_024);
  });

  it("strictly rejects unknown fields, duplicate names, and noncanonical values", () => {
    const decode = (value: unknown) =>
      Schema.decodeUnknownSync(DxdEnvironmentActivateOperation)(value, {
        onExcessProperty: "error",
      });
    const valid = {
      operation: "environment.activate",
      generation: 1,
      git: {
        authorName: "dxcodeagent",
        authorEmail: "agent@dxcode.dev",
        threadUrl:
          "https://dx.example.test/threads/thr_00000000-0000-4000-8000-000000000000",
        signingEnabled: false,
      },
      entries: [{ name: "A", valueBase64Url: "eA" }],
    };
    expect(() => decode({ ...valid, unknown: true })).toThrow();
    expect(() =>
      decode({
        ...valid,
        entries: [
          { name: "B", valueBase64Url: "eA" },
          { name: "A", valueBase64Url: "eQ" },
        ],
      }),
    ).toThrow();
    expect(() =>
      environmentActivationOperation(
        snapshot([
          ["A", "one"],
          ["A", "two"],
        ]),
        1,
      ),
    ).toThrow();
    for (const valueBase64Url of ["", "eA==", "e", "eA+", "AA", "_w"])
      expect(() =>
        decode({ ...valid, entries: [{ name: "A", valueBase64Url }] }),
      ).toThrow();
    expect(() =>
      decode({ ...valid, entries: [{ name: "PATH", valueBase64Url: "eA" }] }),
    ).toThrow();
  });

  it("enforces the decoded value and complete request bounds", () => {
    const maximumValue = "x".repeat(32_768);
    expect(
      environmentActivationOperation(snapshot([["A", maximumValue]]), 1)
        .entries,
    ).toHaveLength(1);
    expect(() =>
      environmentActivationOperation(snapshot([["A", `${maximumValue}x`]]), 1),
    ).toThrow();

    const maximum = Array.from(
      { length: 300 },
      (_, index) =>
        [`VALUE_${String(index).padStart(3, "0")}`, maximumValue] as const,
    );
    const frame = JSON.stringify({
      type: "request",
      generation: "daemon-generation",
      requestId: "request-id",
      operation: environmentActivationOperation(snapshot(maximum), 2),
    });
    expect(new TextEncoder().encode(frame).byteLength).toBeGreaterThan(
      12 * 1_024 * 1_024,
    );
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      DXD_MAX_ENVIRONMENT_REQUEST_FRAME_BYTES,
    );
  });
});
