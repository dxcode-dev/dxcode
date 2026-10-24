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
  [pi, "1.1.0"],
  [agentCore, "1.1.0"],
]) {
  assert.equal(
    JSON.parse(readFileSync(resolve(path, "package.json"))).version,
    version,
  );
}
const revision = "7047c601e7923609e65a9ae09d25eefd9081b2df";
const artifact = readFileSync(resolve(here, `runtime-${revision}.tgz`));
assert.equal(
  createHash("sha256").update(artifact).digest("hex"),
  "5acac748e965c50e10286aa770a57400fb65009dd4f0958aa39d1830fdda2115",
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
    "6e290295616eadc404152a062cdaac405f6016f9038995a284d36b4cdbca6b67",
  ],
  [
    "react",
    react,
    "4365b68adafbfdbed373a4535a093be8a54a23d6e42e864c513e2db0fbd36987",
  ],
  [
    "vite",
    vite,
    "0124efd9d800c168e3e18fbd71a0ae8d7ea052cb9a08afe5eb66dcf9606f2445",
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
  "One exact Flue runtime for core and vite; one Pi ai 1.1.0 / agent-core 1.1.0 graph; all four artifact identities and hashes, retained React session exports, dispatch-only context and awaited undeclared model lookup verified.",
);
