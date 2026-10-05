import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const coreModules = resolve(root, "apps/core/node_modules");
const runtime = realpathSync(resolve(coreModules, "@flue/runtime"));
const vite = realpathSync(resolve(coreModules, "@flue/vite"));
assert.equal(realpathSync(resolve(vite, "../runtime")), runtime);
const pi = realpathSync(resolve(coreModules, "@earendil-works/pi-ai"));
assert.equal(realpathSync(resolve(runtime, "../../@earendil-works/pi-ai")), pi);
const agentCore = realpathSync(
  resolve(runtime, "../../@earendil-works/pi-agent-core"),
);
assert.equal(realpathSync(resolve(agentCore, "../pi-ai")), pi);
for (const [path, version] of [
  [pi, "0.85.1"],
  [agentCore, "0.83.0"],
]) {
  assert.equal(
    JSON.parse(readFileSync(resolve(path, "package.json"))).version,
    version,
  );
}
const revision = "11963758a85ad512c317d4d3ea7d8955bde01432";
const artifact = readFileSync(resolve(here, `runtime-${revision}.tgz`));
assert.equal(
  createHash("sha256").update(artifact).digest("hex"),
  "ec3d5e9cb50c043e9bd4214c827a478167758ed2429273551d224e45da0a5810",
);
assert.ok(
  readFileSync(resolve(runtime, "DX_SOURCE_REVISION"), "utf8").includes(
    revision,
  ),
);
const api = await import(pathToFileURL(resolve(runtime, "dist/index.mjs")));
const sdk = realpathSync(resolve(coreModules, "@flue/sdk"));
const react = realpathSync(resolve(root, "apps/web/node_modules/@flue/react"));
assert.equal(realpathSync(resolve(react, "../sdk")), sdk);
for (const [name, directory, hash] of [
  [
    "sdk",
    sdk,
    "5a820820e33e0688fcc5e298dccf2e0c56b7379dff318b39bb9c1aff02c88d8e",
  ],
  [
    "react",
    react,
    "10e6b506aa8c0d490aac05d7370e1caa0e413b81bedde47ac399177e8cd07386",
  ],
  [
    "vite",
    vite,
    "57e71eb91ee2d271560603d6213e99653f4b041a95ffcf0b1528f571a3650528",
  ],
]) {
  assert.ok(
    readFileSync(resolve(directory, "DX_SOURCE_REVISION"), "utf8").includes(
      revision,
    ),
  );
  assert.equal(
    createHash("sha256")
      .update(readFileSync(resolve(here, `${name}-${revision}.tgz`)))
      .digest("hex"),
    hash,
  );
}
const sdkApi = await import(pathToFileURL(resolve(sdk, "dist/index.mjs")));
const client = sdkApi.createFlueClient({
  url: "https://example.test/agents/fixture/thread",
});
assert.equal("continueQueue" in client, false);
assert.equal("queueState" in client, false);
assert.equal(typeof client.resume, "function");
assert.equal(typeof api.getModelInvocationContext, "function");
assert.equal(typeof api.createModelEventSourceRegistrar, "function");
assert.equal(typeof api.InputTooLargeError, "function");
assert.equal(typeof sdkApi.isInputTooLargeError, "function");
assert.equal(typeof api.usePromptData, "function");
assert.equal(api.getModelInvocationContext(), undefined);
assert.equal("withModelInvocation" in api, false);
assert.equal("lockModelRecoveryPolicy" in api, false);
assert.equal("withoutModelInvocation" in api, false);
assert.equal("resolveRuntimeModel" in api, false);

const webModules = resolve(root, "apps/web/node_modules");
assert.equal(realpathSync(resolve(webModules, "@flue/sdk")), sdk);
const reactApi = await import(pathToFileURL(resolve(react, "dist/index.mjs")));
assert.equal(typeof reactApi.useFlueAgentSession, "function");
assert.equal(typeof reactApi.useFlueAgent, "function");
const retained = reactApi.createFlueAgentSession({
  client: sdkApi.createFlueClient({
    url: "https://verification.invalid/agent",
    fetch: () => {
      throw new Error("Session construction must not fetch");
    },
  }),
});
assert.equal(retained.getSnapshot().hasMore, false);
assert.equal(retained.getSnapshot().loadingOlder, false);
for (const method of [
  "start",
  "stop",
  "dispose",
  "refresh",
  "loadOlder",
  "resume",
  "sendMessage",
  "subscribe",
  "abort",
  "retrySend",
  "resendPrompt",
])
  assert.equal(typeof retained[method], "function");
assert.equal("continueQueue" in retained, false);
assert.equal("queueState" in retained, false);
retained.dispose();

// Exercise the installed artifact without instrumentation or a declared roster.
const { createFlueContext } = await import(
  pathToFileURL(resolve(runtime, "dist/internal.mjs"))
);
const { fauxProvider, fauxAssistantMessage } = await import(
  pathToFileURL(resolve(pi, "dist/providers/faux.js"))
);
const faux = fauxProvider({
  provider: "exact-verification",
  tokensPerSecond: Infinity,
});
const descriptor = faux.getModel();
const lookups = [];
faux.setResponses([
  () => {
    assert.equal(api.getModelInvocationContext()?.instanceId, "verified-owner");
    return fauxAssistantMessage("verified-exact-descriptor");
  },
]);
api.setProvider(
  { ...faux.provider, getModels: () => [] },
  {
    recovery: "provider-owned",
    resolveModel: async (request, context) => {
      assert.equal(api.getModelInvocationContext(), undefined);
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(context), true);
      await Promise.resolve();
      lookups.push({ request, context });
      return {
        ...descriptor,
        id: request.modelId,
        contextWindow: 262144,
        maxTokens: 4096,
      };
    },
  },
);
function VerificationAgent() {
  api.useModel("exact-verification/undeclared-root", { compaction: false });
  return "Local package verification.";
}
const harness = await createFlueContext({
  id: "verified-owner",
  agentName: "verification-agent",
  env: {},
  agentConfig: {
    resolveModel: () => {
      throw new Error("Unexpected synchronous fallback");
    },
  },
}).initializeRootHarness(VerificationAgent);
try {
  const session = await harness.session();
  const response = await session.prompt("verify", {
    model: "exact-verification/undeclared-override",
  });
  assert.equal(response.text, "verified-exact-descriptor");
  assert.deepEqual(
    lookups.map(({ request }) => request.modelId),
    ["undeclared-root", "undeclared-override"],
  );
  assert.equal("scope" in lookups[0].context, false);
  assert.equal(lookups[1].context.scope.kind, "operation");
  assert.equal(Object.isFrozen(lookups[1].context.scope), true);
  assert.equal(
    lookups.every(
      ({ context }) =>
        context.agentName === "verification-agent" &&
        context.recovery === false,
    ),
    true,
  );
} finally {
  await harness.close();
}
assert.equal(api.getModelInvocationContext(), undefined);
console.log(
  "One exact Flue runtime for core and vite; one Pi ai 0.85.1 / agent-core 0.83.0 graph; all four artifact identities and hashes, retained React session exports, dispatch-only context and awaited undeclared model lookup verified.",
);
