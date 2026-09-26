import type { SandboxFactory } from "@flue/runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: { DX_RUNTIME_MODE: "deployed" },
}));
vi.mock("../execution/execution-workspaces.js", () => ({
  ExecutionWorkspaces: {
    sandboxFactory: { createSandbox: vi.fn() },
  },
}));

import {
  LOCAL_MODEL_FIXTURE_ROUTE,
  makeAgentRuntimeComposition,
} from "./agent-composition.js";

describe("agent runtime composition", () => {
  it("uses resolved prompt data over the selection fallback", () => {
    const execution = {
      createSandbox: vi.fn(),
    } as unknown as SandboxFactory;
    const runtime = makeAgentRuntimeComposition(
      { DX_RUNTIME_MODE: "deployed" },
      execution,
    );

    expect(runtime.execution).toBe(execution);
    expect(runtime.capabilities).toBe("workspace");
    expect(
      runtime.model.select({
        model: "openai/gpt-6-astra",
        thinking: "medium",
      }),
    ).toEqual({
      model: "openai/gpt-6-astra",
      options: { thinkingLevel: "medium" },
    });
  });

  it("deployed selection without prompt data fails visibly", () => {
    const execution = {
      createSandbox: vi.fn(),
    } as unknown as SandboxFactory;
    const runtime = makeAgentRuntimeComposition(
      { DX_RUNTIME_MODE: "deployed" },
      execution,
    );

    expect(() => runtime.model.select(undefined)).toThrow(
      /Model routing unavailable/,
    );
  });

  it("local keeps the fixture fallback when no route resolves", () => {
    const execution = {
      createSandbox: vi.fn(),
    } as unknown as SandboxFactory;
    const runtime = makeAgentRuntimeComposition(
      { DX_RUNTIME_MODE: "local" },
      execution,
    );

    expect(runtime.model.select(undefined)).toEqual({
      model: LOCAL_MODEL_FIXTURE_ROUTE,
      options: undefined,
    });
    expect(runtime.execution).toBe(execution);
    expect(runtime.capabilities).toBe("workspace");
  });

  it("selects Workers AI without a sandbox for an explicit local model preview", () => {
    const execution = {
      createSandbox: vi.fn(),
    } as unknown as SandboxFactory;
    const runtime = makeAgentRuntimeComposition(
      { DX_RUNTIME_MODE: "local", DX_LOCAL_MODEL_PREVIEW: "1" },
      execution,
    );

    expect(runtime.capabilities).toBe("model-only");
    expect(runtime.execution).toBeUndefined();
    expect(runtime.model.select(undefined)).toEqual({
      model: "cloudflare/@cf/zai-org/glm-5.3-flash",
      options: undefined,
    });
  });
});
