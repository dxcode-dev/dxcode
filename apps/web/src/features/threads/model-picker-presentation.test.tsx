import { modelDisplayName } from "./model-display-name.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServingBadge } from "./model-picker-presentation.js";

describe("model picker presentation", () => {
  it("keeps model versions and converts routing IDs to readable names", () => {
    expect(modelDisplayName("openai/gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(modelDisplayName("anthropic/claude-fable-5-1")).toBe(
      "Claude Fable 5.1",
    );
    expect(modelDisplayName("GPT-6 Astra")).toBe("GPT-6 Astra");
  });
  it("does not pretend an unserved model has a provider", () => {
    expect(renderToStaticMarkup(<ServingBadge name={null} />)).toContain(
      "Not served",
    );
    expect(
      renderToStaticMarkup(<ServingBadge name="Custom gateway" />),
    ).toContain("Served by Custom gateway");
  });
});
