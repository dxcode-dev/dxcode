import { describe, expect, it, vi } from "vitest";
import { createDxSubscriptionFlueProvider } from "./flue-provider.js";

describe("dx personal subscription Flue provider", () => {
  it("registers the reviewed catalog over one structural binding", () => {
    const run = vi.fn();
    const provider = createDxSubscriptionFlueProvider({ run });
    expect(provider.id).toBe("dx-subscription");
    expect(provider.getModels()).toHaveLength(36);
    expect(provider.getModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.6-luna",
          provider: "dx-subscription",
          api: "openai-responses",
          reasoning: true,
        }),
        expect.objectContaining({
          id: "claude-opus-5",
          provider: "dx-subscription",
          api: "anthropic-messages",
        }),
      ]),
    );
    expect(run).not.toHaveBeenCalled();
  });
});
