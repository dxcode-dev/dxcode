import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  defaultThreadModelSelection,
  ModelId,
  ModelNotServed,
  StoredModelConnection,
  ThreadModelSelection,
} from "./model-routing.js";

const baseConnection = {
  id: "conn-1",
  target: { scope: "personal", id: "user-1" },
  name: "LiteLLM",
  providerId: "openai",
  fields: {},
  headers: [],
  models: [],
  enabled: true,
  priority: 0,
  health: { state: "untested", code: "NOT_TESTED" },
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
};

describe("model routing domain", () => {
  it("accepts canonical provider/model ids and rejects everything else", () => {
    for (const id of [
      "openai/gpt-5.6-sol",
      "anthropic/claude-fable-5-1",
      "cloudflare/@cf/zai-org/glm-5.3-flash",
      "github-copilot/gpt-5.6-luna",
      "dx-custom/custom-model",
    ]) {
      expect(Schema.decodeUnknownResult(ModelId)(id)._tag).toBe("Success");
    }
    for (const id of [
      "gpt-5.6-sol",
      "/model",
      "provider/",
      "a b/c",
      "",
      "x/",
    ]) {
      expect(Schema.decodeUnknownResult(ModelId)(id)._tag).toBe("Failure");
    }
  });

  it("requires baseUrl and format on custom connections only", () => {
    const custom = {
      ...baseConnection,
      kind: "custom",
      providerId: "dx-custom",
      baseUrl: "https://models.example.com/v1",
      format: "openai-completions",
      models: [{ canonical: "dx-custom/custom-model", upstream: "internal" }],
    };
    expect(Schema.decodeUnknownResult(StoredModelConnection)(custom)._tag).toBe(
      "Success",
    );
    expect(
      Schema.decodeUnknownResult(StoredModelConnection)({
        ...custom,
        baseUrl: undefined,
      })._tag,
    ).toBe("Failure");
    expect(
      Schema.decodeUnknownResult(StoredModelConnection)({
        ...custom,
        format: undefined,
      })._tag,
    ).toBe("Failure");
    expect(
      Schema.decodeUnknownResult(StoredModelConnection)({
        ...baseConnection,
        kind: "provider",
        format: "openai-completions",
      })._tag,
    ).toBe("Failure");
    expect(
      Schema.decodeUnknownResult(StoredModelConnection)({
        ...baseConnection,
        kind: "subscription",
        baseUrl: "https://models.example.com",
      })._tag,
    ).toBe("Failure");
    expect(
      Schema.decodeUnknownResult(StoredModelConnection)({
        ...baseConnection,
        kind: "provider",
        models: [{ canonical: "openai/gpt-5.6-sol" }],
      })._tag,
    ).toBe("Failure");
    expect(
      Schema.decodeUnknownResult(StoredModelConnection)({
        ...baseConnection,
        kind: "deployment",
        credentialId: "mcred_1",
      })._tag,
    ).toBe("Failure");
  });

  it("models a thread selection as a mode or a raw canonical model", () => {
    expect(defaultThreadModelSelection()).toEqual({
      kind: "mode",
      profileId: "default",
      mode: "medium",
    });
    expect(
      Schema.decodeUnknownResult(ThreadModelSelection)({
        kind: "mode",
        profileId: "default",
        mode: "ultra",
      })._tag,
    ).toBe("Success");
    expect(
      Schema.decodeUnknownResult(ThreadModelSelection)({
        kind: "model",
        model: "openai/gpt-6-astra",
      })._tag,
    ).toBe("Success");
    expect(
      Schema.decodeUnknownResult(ThreadModelSelection)({
        kind: "model",
        model: "gpt-6-astra",
      })._tag,
    ).toBe("Failure");
    expect(
      Schema.decodeUnknownResult(ThreadModelSelection)({
        kind: "mode",
        profileId: "custom",
        mode: "low",
      })._tag,
    ).toBe("Failure");
  });

  it("keeps ModelNotServed a typed error with the frozen reasons", () => {
    const error = new ModelNotServed({
      model: Schema.decodeUnknownSync(ModelId)("openai/gpt-6-astra"),
      reason: "no-connection",
    });
    expect(error._tag).toBe("ModelNotServed");
    expect(
      Schema.decodeUnknownResult(ModelNotServed)({
        _tag: "ModelNotServed",
        model: "openai/gpt-6-astra",
        reason: "unknown-model",
      })._tag,
    ).toBe("Success");
    expect(
      Schema.decodeUnknownResult(ModelNotServed)({
        _tag: "ModelNotServed",
        model: "openai/gpt-6-astra",
        reason: "rate-limited",
      })._tag,
    ).toBe("Failure");
  });
});
