import { env } from "cloudflare:test";
import type { Sandbox } from "@flue/runtime";
import { expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { SourceMutationRejected } from "../../src/source-control/operations.js";
import { sourceControlTools } from "../../src/source-control/tools.js";

const invoke = async (data: unknown) => {
  const tool = sourceControlTools("thread-bitbucket-local-rejection", {
    bindings: { DB: env.DB } as Bindings,
    providerForThread: async () => "bitbucket",
  }).find(({ name }) => name === "pull_request");
  if (tool === undefined) throw new Error("Missing pull_request tool.");
  return (tool.run as (context: unknown) => Promise<unknown>)({
    data,
    harness: {
      sandbox: {
        cwd: "/home/user/workspace/repo",
        exec: vi.fn(),
      } as unknown as Sandbox,
    },
  });
};

it.each(["create", "update"] as const)(
  "persists no operation for repeated over-limit Bitbucket PR %s attempts",
  async (action) => {
    const providerLimit = 8_192;
    const markerLength =
      "\n\n".length + "<!-- dx-op:".length + 64 + " -->".length;
    const maximumInputLength = providerLimit - markerLength;
    const astralCharacters = 7_888;
    const basicCharacters = maximumInputLength + 1 - astralCharacters;
    const input = {
      action,
      ...(action === "create"
        ? { head: "feature", base: "main", title: "Change" }
        : { number: 7 }),
      body: "😀".repeat(astralCharacters) + "x".repeat(basicCharacters),
      idempotencyKey: `worker-bitbucket-${action}-body-limit`,
    };
    expect([...input.body]).toHaveLength(8_112);
    expect(input.body.length).toBe(16_000);

    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(invoke(input)).rejects.toBeInstanceOf(
        SourceMutationRejected,
      );
    await expect(
      env.DB.prepare(
        "SELECT state, attempt FROM source_control_operation WHERE thread_id = ?",
      )
        .bind("thread-bitbucket-local-rejection")
        .all(),
    ).resolves.toMatchObject({ results: [] });
  },
);
