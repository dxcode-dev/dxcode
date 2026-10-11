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
vi.mock("./settings/model-subscriptions/invocation.js", () => ({
  SubscriptionCredentialCoordinatorObject: class {},
}));
vi.mock("./settings/model-byok/invocation.js", () => ({
  ByokCredentialCoordinatorObject: class {},
}));
vi.mock("./settings/triggers/durable-object.js", () => ({
  PluginTriggerDeliveryObject: class {},
}));
vi.mock("./thread-search/index-object.js", () => ({
  ThreadSearchIndexObject: class {},
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
});
