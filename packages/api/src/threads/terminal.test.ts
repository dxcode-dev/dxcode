import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  THREAD_TERMINAL_ATTACHMENT_LIMIT,
  THREAD_TERMINAL_BINARY_MAX_BYTES,
  THREAD_TERMINAL_CONTROL_MAX_BYTES,
  THREAD_TERMINAL_SUBPROTOCOL,
  ThreadTerminalBrowserControlSchema,
  ThreadTerminalServerControlSchema,
} from "./terminal.js";

const strict = { onExcessProperty: "error" } as const;

describe("Thread Terminal browser protocol v1", () => {
  it("publishes the fixed negotiation and frame bounds", () => {
    expect(THREAD_TERMINAL_SUBPROTOCOL).toBe("dx-terminal.v1");
    expect(THREAD_TERMINAL_CONTROL_MAX_BYTES).toBe(4_096);
    expect(THREAD_TERMINAL_BINARY_MAX_BYTES).toBe(65_486);
    expect(THREAD_TERMINAL_ATTACHMENT_LIMIT).toBe(8);
  });

  it("accepts the attach, resize, detach, and recover subset", () => {
    for (const control of [
      {
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 80, rows: 20 },
      },
      {
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 80, rows: 20 },
        restartResident: true,
      },
      { v: 1, type: "resize", dimensions: { columns: 1_000, rows: 1 } },
      { v: 1, type: "detach" },
      { v: 1, type: "recover" },
    ])
      expect(
        Schema.decodeUnknownSync(ThreadTerminalBrowserControlSchema)(
          control,
          strict,
        ),
      ).toEqual(control);
  });

  it.each([
    ["wrong version", { v: 2, type: "detach" }],
    ["unknown type", { v: 1, type: "fork" }],
    [
      "second logical Terminal",
      {
        v: 1,
        type: "attach",
        terminal: "secondary",
        dimensions: { columns: 80, rows: 20 },
      },
    ],
    [
      "false resident restart",
      {
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 80, rows: 20 },
        restartResident: false,
      },
    ],
    ["unknown field", { v: 1, type: "detach", providerId: "must-not-cross" }],
    [
      "zero columns",
      {
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 0, rows: 20 },
      },
    ],
    [
      "too many rows",
      {
        v: 1,
        type: "resize",
        dimensions: { columns: 80, rows: 1_001 },
      },
    ],
  ])("rejects %s", (_name, control) => {
    expect(() =>
      Schema.decodeUnknownSync(ThreadTerminalBrowserControlSchema)(
        control,
        strict,
      ),
    ).toThrow();
  });

  it("accepts the explicit environment restart control", () => {
    expect(
      Schema.decodeUnknownSync(ThreadTerminalBrowserControlSchema)(
        { v: 1, type: "restart" },
        strict,
      ),
    ).toEqual({ v: 1, type: "restart" });
  });

  it("accepts only fixed safe server controls", () => {
    const controls = [
      { v: 1, type: "progress", phase: "replaying" },
      { v: 1, type: "replay-start", reset: true, truncated: false },
      {
        v: 1,
        type: "ready",
        terminal: "default",
        dimensions: { columns: 80, rows: 20 },
        replayBytes: 12,
        replayTruncated: false,
        restartRequired: false,
      },
      {
        v: 1,
        type: "dimensions",
        dimensions: { columns: 132, rows: 43 },
      },
      { v: 1, type: "restart-required", restartRequired: true },
      {
        v: 1,
        type: "error",
        code: "resident-unavailable",
        retry: "manual",
      },
    ];
    for (const control of controls)
      expect(
        Schema.decodeUnknownSync(ThreadTerminalServerControlSchema)(
          control,
          strict,
        ),
      ).toEqual(control);
  });

  it.each([
    {
      v: 1,
      type: "ready",
      terminal: "default",
      dimensions: { columns: 80, rows: 20 },
      replayBytes: 0,
      replayTruncated: false,
      restartRequired: false,
    },
    {
      v: 1,
      type: "error",
      code: "provider-secret",
      retry: "manual",
    },
    {
      v: 1,
      type: "error",
      code: "resident-unavailable",
      retry: "manual",
      cause: "private terminal content",
    },
  ])("rejects unsafe server control %#", (control) => {
    expect(() =>
      Schema.decodeUnknownSync(ThreadTerminalServerControlSchema)(
        control,
        strict,
      ),
    ).toThrow();
  });
});
