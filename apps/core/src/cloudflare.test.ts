import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registration = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  fixture: vi.fn(),
  setProvider:
    vi.fn<
      (provider: {
        readonly id: string;
        readonly getModels: () => readonly unknown[];
      }) => void
    >(),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  get env() {
    return registration.env;
  },
}));
vi.mock("@flue/runtime", () => ({
  setProvider: registration.setProvider,
  getModelInvocationContext: vi.fn(),
}));
vi.mock("@flue/runtime/cloudflare", () => ({
  getDurableObjectIdentity: vi.fn(),
}));
vi.mock("./logging.js", () => ({
  settingsPersistenceLogger: { warn: vi.fn() },
}));
vi.mock("./runtime/model-fixtures.js", () => ({
  registerLocalModelFixtureProvider: registration.fixture,
}));
vi.mock("./settings/model-subscriptions/flue-provider.js", () => ({
  createDxSubscriptionFlueProvider: vi.fn(),
}));
vi.mock("./settings/model-subscriptions/invocation.js", () => ({
  createDxSubscriptionCloudflareBinding: vi.fn(),
  SubscriptionCredentialCoordinatorObject: class {},
}));
vi.mock("./settings/model-byok/invocation.js", () => ({
  ByokCredentialCoordinatorObject: class {},
}));
vi.mock("./settings/triggers/durable-object.js", () => ({
  PluginTriggerDeliveryObject: class {},
}));
vi.mock("./threads/terminal-object.js", () => ({
  ThreadExecutionObject: class {},
}));

describe("Cloudflare model provider registration", () => {
  beforeEach(() => {
    vi.resetModules();
    registration.fixture.mockReset();
    registration.setProvider.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers only the local fixture in local mode", async () => {
    registration.env = {
      DX_RUNTIME_MODE: "local",
      AI: { run: vi.fn() },
    };
    vi.stubGlobal("__DX_CORE_DEV_FIXTURES__", true);
    await import("./cloudflare.js");

    expect(registration.fixture).toHaveBeenCalledOnce();
    expect(registration.setProvider).not.toHaveBeenCalled();
  });

  it("registers Workers AI for the explicit sandbox-free local model preview", async () => {
    registration.env = {
      DX_RUNTIME_MODE: "local",
      DX_LOCAL_MODEL_PREVIEW: "1",
      AI: { run: vi.fn() },
    };
    vi.stubGlobal("__DX_CORE_DEV_FIXTURES__", true);
    await import("./cloudflare.js");

    expect(registration.fixture).not.toHaveBeenCalled();
    expect(registration.setProvider).toHaveBeenCalledOnce();
    expect(registration.setProvider.mock.calls[0]?.[0]).toMatchObject({
      id: "cloudflare",
    });
  });

  it("routes every deployed provider, including the binding, through submission resolution", async () => {
    registration.env = {
      DX_RUNTIME_MODE: "deployed",
      AI: { run: vi.fn() },
      DB: {},
      BYOK_CREDENTIAL_COORDINATOR: {},
    };
    vi.stubGlobal("__DX_CORE_DEV_FIXTURES__", false);
    await import("./cloudflare.js");

    expect(registration.fixture).not.toHaveBeenCalled();
    const provider = registration.setProvider.mock.calls.find(
      ([provider]) => provider.id === "cloudflare",
    )?.[0];
    expect(
      registration.setProvider.mock.calls.some(
        ([registered]) => registered.id === "github-copilot",
      ),
    ).toBe(true);
    expect(provider).toMatchObject({ id: "cloudflare" });
    expect(provider?.getModels()).toContainEqual(
      expect.objectContaining({
        id: "@cf/zai-org/glm-5.3-flash",
        contextWindow: 1_310_720,
        maxTokens: 1_048_576,
        reasoning: true,
        input: ["text", "image"],
      }),
    );
  });
});
