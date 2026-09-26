import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CatalogResponseSchema,
  ConnectionDataSchema,
  GraphResponseSchema,
  ProfileResponseSchema,
} from "./model-routing.js";

const connection = {
  id: "conn-openai",
  name: "OpenAI",
  kind: "provider",
  providerId: "openai",
  fields: {},
  headers: [],
  models: [],
  enabled: true,
  priority: 0,
  health: { state: "untested", code: "NOT_TESTED" },
  credential: { present: true, tail: "Lk9x" },
  serves: "catalog",
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
};

describe("model routing API contracts", () => {
  it("never serialises credential or header plaintext", () => {
    const decoded = Schema.decodeUnknownSync(ConnectionDataSchema)(connection);
    const encoded = Schema.encodeUnknownSync(ConnectionDataSchema)(decoded);
    expect(encoded.credential).toEqual({ present: true, tail: "Lk9x" });
    expect(JSON.stringify(encoded)).not.toMatch(
      /sk-|plaintext|ciphertext|envelope|apiKey/,
    );
    const withHeaders = Schema.encodeUnknownSync(ConnectionDataSchema)(
      Schema.decodeUnknownSync(ConnectionDataSchema)({
        ...connection,
        headers: [{ name: "x-tenant", masked: "••••1234" }],
      }),
    );
    expect(withHeaders.headers[0].masked).toBe("••••1234");
    expect(() =>
      Schema.decodeUnknownSync(ConnectionDataSchema)({
        ...connection,
        credential: { present: true, tail: "sk-live-secret" },
      }),
    ).not.toThrow();
  });

  it("describes providers by connection kind and transport family", () => {
    const decoded = Schema.decodeUnknownSync(CatalogResponseSchema)({
      status: "success",
      data: {
        providers: [
          {
            id: "google",
            name: "Google",
            description: "Gemini models",
            connectionKind: "provider",
            transport: "in-do",
            fields: [],
            models: [
              {
                id: "google/gemini-3.8-flash",
                name: "Gemini 3.8 Flash",
                contextWindow: 1_000_000,
                maxOutputTokens: 65_536,
                reasoning: true,
                vision: true,
              },
            ],
          },
        ],
      },
    });
    expect(decoded.data.providers[0].transport).toBe("in-do");
    expect(() =>
      Schema.decodeUnknownSync(CatalogResponseSchema)({
        status: "success",
        data: {
          providers: [{ ...decoded.data.providers[0], transport: "sideways" }],
        },
      }),
    ).toThrow();
  });

  it("marks unserved modes with a null edge destination", () => {
    const decoded = Schema.decodeUnknownSync(GraphResponseSchema)({
      status: "success",
      data: {
        modes: [
          {
            mode: "low",
            config: { model: "openai/gpt-5.6-terra", thinking: "max" },
            source: "default",
            served: false,
          },
        ],
        connections: [],
        edges: [
          { mode: "low", model: "openai/gpt-5.6-terra", connectionId: null },
        ],
      },
    });
    expect(decoded.data.edges[0].connectionId).toBeNull();
  });

  it("distinguishes default and overridden modes in the profile", () => {
    const decoded = Schema.decodeUnknownSync(ProfileResponseSchema)({
      status: "success",
      data: {
        id: "default",
        modes: {
          low: {
            config: {
              agent: { model: "openai/gpt-5.6-terra", thinking: "max" },
            },
            source: "override",
          },
          medium: {
            config: {
              agent: { model: "openai/gpt-5.6-sol", thinking: "high" },
            },
            source: "default",
          },
          high: {
            config: {
              agent: { model: "openai/gpt-6-astra", thinking: "medium" },
            },
            source: "default",
          },
          ultra: {
            config: {
              agent: { model: "anthropic/claude-fable-5-1", thinking: "high" },
            },
            source: "default",
          },
        },
      },
    });
    expect(decoded.data.modes.low.source).toBe("override");
    expect(() =>
      Schema.decodeUnknownSync(ProfileResponseSchema)({
        status: "success",
        data: { id: "other", modes: decoded.data.modes },
      }),
    ).toThrow();
  });
});
