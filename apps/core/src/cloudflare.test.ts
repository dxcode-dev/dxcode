import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registration = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  fixture: vi.fn(),
  configureRetryPolicy: vi.fn(),
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
  configureRetryPolicy: registration.configureRetryPolicy,
  setProvider: registration.setProvider,
  getModelInvocationContext: vi.fn(),
}));
vi.mock("@flue/runtime/cloudflare", () => ({
  getDurableObjectIdentity: vi.fn(),
}));
vi.mock("./logging.js", () => ({
  settingsPersistenceLogger: { warn: vi.fn() },
}));
vi.mock("./observability/flue-tracing.js", () => ({
  installContentFreeFlueTracing: vi.fn(),
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
    registration.configureRetryPolicy.mockReset();
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

  it("retries transient and platform failures on dx's schedule and stops account ones", async () => {
    registration.env = { DX_RUNTIME_MODE: "local" };
    await import("./cloudflare.js");
    const [policy] = registration.configureRetryPolicy.mock.calls[0] as [
      {
        modelRetryPolicy: (input: {
          errorMessage: string;
          attempt: number;
        }) => number | undefined;
        submissionRetryPolicy: (input: {
          error: unknown;
          errorMessage: string;
          attempt: number;
        }) => number | undefined;
      },
    ];
    const model = (errorMessage: string, attempt = 1) =>
      policy.modelRetryPolicy({ errorMessage, attempt });

    // A Cloudflare 520 from LiteLLM retries; so does a reset object.
    expect(
      model("520: <html>Web server is returning an unknown error"),
    ).toBeGreaterThan(0);
    expect(
      policy.submissionRetryPolicy({
        error: new Error("x"),
        errorMessage: "Durable Object reset because its code was updated.",
        attempt: 3,
      }),
    ).toBeGreaterThan(0);
    // A LiteLLM budget 429 is the account's: no retry, even though it is a 429.
    expect(
      model(
        '429: {"message":"Budget has been exceeded! Max budget: 1000.0","type":"budget_exceeded"}',
      ),
    ).toBeUndefined();
    // A stamp from the layer that knew wins over the text.
    expect(
      model(
        "Request timed out (dx_failure:account:PROVIDER_AUTHENTICATION_FAILED)",
      ),
    ).toBeUndefined();
    // The schedule ends.
    expect(model("503 Service Unavailable", 12)).toBeUndefined();
  });
});
