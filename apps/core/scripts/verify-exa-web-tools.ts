// Opt-in live verification. Requires explicit authorization to consume credits.
// At most five Exa requests; no retries. Never prints credentials or raw payloads.
import assert from "node:assert/strict";
import { WebToolError } from "@dx/domain";
import { Redacted } from "effect";
import * as v from "valibot";
import { createExaWebProvider } from "../src/plugins/web/providers/exa.js";
import { createWebTools } from "../src/plugins/web/tools.js";

async function main() {
  if (process.env.DX_VERIFY_EXA_LIVE !== "1") {
    throw new Error("Explicit DX_VERIFY_EXA_LIVE=1 opt-in required.");
  }
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) throw new Error("EXA_API_KEY absent.");
  let requests = 0;
  const transport: typeof fetch = async (url, init) => {
    assert.ok(requests < 5, "Five-request verification budget exhausted.");
    requests += 1;
    const response = await fetch(url, init);
    console.log(
      JSON.stringify({
        request: requests,
        endpoint: new URL(String(url)).pathname,
        httpStatus: response.status,
      }),
    );
    return response;
  };
  // The same provider-neutral tools DxAgent mounts, bound directly to the
  // Exa provider instead of the call-time host (no D1 or metering here).
  const provider = createExaWebProvider(Redacted.make(key), transport);
  const tools = createWebTools(
    ["web.search", "web.read"],
    (_capability, call) => call(provider),
  );
  const invoke = async (name: string, input: unknown) => {
    const tool = tools.find((tool) => tool.name === name);
    assert.ok(tool, "Expected native web tool is unavailable.");
    const data = v.parse(tool.input, input);
    const result = await tool.run({
      data,
      signal: new AbortController().signal,
    } as never);
    // Do not dump a response or assertion's actual value on failure.
    assert.ok(
      typeof result === "object" && result !== null && "output" in result,
    );
    return result.output as unknown;
  };
  try {
    const search = await invoke("web_search", {
      objective: "IANA example domains reserved for documentation example.com",
      max_results: 3,
    });
    const sources = search as Array<{
      title: string;
      url: string;
      excerpts: Array<string>;
    }>;
    assert.ok(Array.isArray(sources));
    assert.ok(sources.length > 0 && sources.length <= 3);
    assert.ok(
      sources.some((source) =>
        new URL(source.url).hostname.endsWith("iana.org"),
      ),
    );
    assert.ok(sources.some((source) => source.excerpts.length > 0));
    console.log(
      JSON.stringify({
        check: "search",
        passed: true,
        sourceCount: sources.length,
        includesIana: true,
      }),
    );

    const url = "https://example.com/";
    for (const [label, input] of [
      ["full", { url, fullContent: true }],
      ["excerpts", { url, objective: "What is this domain for?" }],
      [
        "fresh-excerpts",
        { url, objective: "What is this domain for?", forceRefetch: true },
      ],
    ] as const) {
      const output = await invoke("read_web_page", input);
      assert.ok(typeof output === "string");
      assert.ok(/documentation examples/i.test(output));
      // Page wording changes over time; assert only its stable identity.
      if (label === "full") assert.ok(output.includes("Example Domain"));
      console.log(
        JSON.stringify({
          check: label,
          passed: true,
          characters: output.length,
        }),
      );
    }
    try {
      await invoke("read_web_page", {
        url: "https://example.com/dx-verification-missing-page-20260907",
        fullContent: true,
      });
      throw new Error("Missing page unexpectedly returned successful content.");
    } catch (error) {
      assert.ok(error instanceof WebToolError && error.code === "target_error");
      assert.ok(!JSON.stringify(error).includes(key));
      console.log(
        JSON.stringify({
          check: "missing-page",
          passed: true,
          code: error.code,
          message: error.message,
        }),
      );
    }
  } finally {
    console.log(JSON.stringify({ requests, retries: 0 }));
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      passed: false,
      code: error instanceof WebToolError ? error.code : "verification_failed",
      message:
        error instanceof WebToolError
          ? error.message
          : "Live verification assertion or setup failed; raw error suppressed.",
    }),
  );
  process.exitCode = 1;
});
