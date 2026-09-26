import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../http/types.js";
import {
  localSandboxFactory,
  validateLocalRuntimeConfiguration,
} from "./adapter.js";

const bindings = {
  DX_LOCAL_RUNTIME_URL: "http://127.0.0.1:5175/",
  DX_LOCAL_RUNTIME_TOKEN: "local-runtime-test-token-000000000000",
} satisfies Bindings;

afterEach(() => vi.restoreAllMocks());

describe("local execution workspace adapter", () => {
  it.each([
    "https://runtime.example/",
    "http://runtime.example/",
    "http://127.0.0.1:5175/path",
  ])("rejects non-loopback runtime authority %s", (url) => {
    expect(() =>
      validateLocalRuntimeConfiguration({
        ...bindings,
        DX_LOCAL_RUNTIME_URL: url,
      }),
    ).toThrow("unavailable");
  });

  it("uses only the authenticated loopback sidecar for one Thread workspace", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (request) => {
        const url = new URL(
          request instanceof Request ? request.url : request.toString(),
        );
        if (url.pathname.endsWith("/ensure"))
          return Response.json({ cwd: "/home/user/workspace/repo" });
        if (url.pathname.endsWith("/exec"))
          return Response.json({ stdout: "local\n", stderr: "", exitCode: 0 });
        return Response.json({});
      });
    const sandbox = await localSandboxFactory(bindings).createSandbox({
      id: "thr_00000000-0000-4000-8000-000000000331",
    });
    const controller = new AbortController();

    await expect(
      sandbox.exec("pwd", { signal: controller.signal }),
    ).resolves.toEqual({
      stdout: "local\n",
      stderr: "",
      exitCode: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toMatchObject({
        authorization: `Bearer ${bindings.DX_LOCAL_RUNTIME_TOKEN}`,
      });
    }
    expect(fetch.mock.calls.map(([request]) => String(request))).toEqual([
      expect.stringContaining(
        "/v1/workspaces/thr_00000000-0000-4000-8000-000000000331/ensure",
      ),
      expect.stringContaining(
        "/v1/workspaces/thr_00000000-0000-4000-8000-000000000331/exec",
      ),
    ]);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      existingOnly: false,
      prepareSourceWorkspace: true,
    });
    expect(fetch.mock.calls[1]?.[1]?.signal).toBe(controller.signal);
  });
});
