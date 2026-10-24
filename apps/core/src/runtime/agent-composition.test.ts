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
import { classifyRunFailure } from "./run-failure.js";

describe("agent runtime composition", () => {
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

  it("keeps the coordinator's failure class when route resolution fails", async () => {
    const coordinatorAnswering = (response: () => Response) => ({
      DX_RUNTIME_MODE: "deployed",
      BYOK_CREDENTIAL_COORDINATOR: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => response() }),
      },
    });
    const resolveWith = (response: () => Response) =>
      makeAgentRuntimeComposition(
        coordinatorAnswering(response) as never,
        { createSandbox: vi.fn() } as unknown as SandboxFactory,
      )
        .model.resolvePromptData({
          instanceId: "thr_1",
          agentName: "dx",
          scope: { kind: "prompt", submissionId: "sub-1" },
          signal: new AbortController().signal,
          recovery: false,
        })
        .then(
          () => undefined,
          (error: unknown) =>
            classifyRunFailure({ message: (error as Error).message }),
        );

    // A stalled route lookup is the platform's, and retries.
    await expect(
      resolveWith(() =>
        Response.json(
          {
            code: "MODEL_ROUTING_TIMEOUT",
            class: "platform",
            message: "Preparing the model route timed out.",
          },
          { status: 502 },
        ),
      ),
    ).resolves.toMatchObject({
      class: "platform",
      code: "MODEL_ROUTING_TIMEOUT",
      retryable: true,
    });
    // A reset coordinator answers in plain text, not JSON.
    await expect(
      resolveWith(
        () =>
          new Response("Internal error; reference = abc123", { status: 500 }),
      ),
    ).resolves.toMatchObject({ class: "platform", retryable: true });
    // A route that cannot exist fails once instead of retrying.
    await expect(
      resolveWith(() =>
        Response.json({ code: "THREAD_ROUTE_NOT_FOUND" }, { status: 400 }),
      ),
    ).resolves.toMatchObject({
      code: "THREAD_ROUTE_NOT_FOUND",
      retryable: false,
    });
    // An account failure stays final.
    await expect(
      resolveWith(() =>
        Response.json(
          {
            code: "BUDGET_EXCEEDED",
            class: "account",
            message: "The connection is over its budget.",
          },
          { status: 400 },
        ),
      ),
    ).resolves.toMatchObject({
      class: "account",
      code: "BUDGET_EXCEEDED",
      retryable: false,
    });
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
