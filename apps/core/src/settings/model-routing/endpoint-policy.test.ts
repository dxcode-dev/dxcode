import { describe, expect, it } from "vitest";
import { validateAllowedModelEndpoint } from "./endpoint-policy.js";

describe("model endpoint policy", () => {
  it("normalizes public HTTPS endpoints and compares configured entries by origin", () => {
    expect(
      validateAllowedModelEndpoint(
        "https://models.example.com/v1/",
        "https://models.example.com/ignored-path",
      ),
    ).toEqual({ endpoint: "https://models.example.com/v1" });
    expect(
      validateAllowedModelEndpoint("https://models.example.com/v1"),
    ).toEqual({ endpoint: "https://models.example.com/v1" });
  });

  it("applies an explicit allowlist uniformly, including to OpenAI", () => {
    expect(
      validateAllowedModelEndpoint(
        "https://api.openai.com/v1",
        "https://models.example.com",
      ),
    ).toEqual({ error: "not-allowlisted" });
  });

  it("fails closed when a nonempty allowlist has no valid origins", () => {
    expect(
      validateAllowedModelEndpoint(
        "https://models.example.com/v1",
        "not a URL",
      ),
    ).toEqual({ error: "not-allowlisted" });
  });

  it.each([
    "http://models.example.com/v1",
    "https://user:secret@models.example.com/v1",
    "https://models.example.com/v1?token=secret",
    "https://localhost/v1",
    "https://localhost./v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.1/v1",
    "https://[::1]/v1",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(validateAllowedModelEndpoint(endpoint)).toEqual({
      error: "invalid",
    });
  });
});
