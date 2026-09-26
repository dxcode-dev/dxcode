import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CreatePersonalApiTokenResponseSchema,
  ListBrowserSessionsQuerySchema,
  ListBrowserSessionsResponseSchema,
  ListPersonalApiTokensResponseSchema,
} from "./personal-security.js";

describe("personal security HTTP contracts", () => {
  it("bounds session pagination", () => {
    expect(
      Schema.decodeUnknownSync(ListBrowserSessionsQuerySchema)({
        limit: "25",
        offset: "50",
      }),
    ).toEqual({ limit: 25, offset: 50 });
    expect(() =>
      Schema.decodeUnknownSync(ListBrowserSessionsQuerySchema)({
        limit: "101",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ListBrowserSessionsQuerySchema)({
        offset: "-1",
      }),
    ).toThrow();
  });

  it("models plaintext only in create or rotate output", () => {
    const created = Schema.decodeUnknownSync(
      CreatePersonalApiTokenResponseSchema,
    )({
      status: "success",
      data: {
        plaintext: `dxu_${"a".repeat(40)}`,
        token: {
          id: "token-1",
          name: "Local CLI",
          identifier: "dxu_abcd1234",
          scopes: ["projects:read"],
          createdAt: "2026-08-23T12:00:00.000Z",
        },
      },
    });
    expect(created.data.plaintext).toMatch(/^dxu_/);

    const listed = Schema.decodeUnknownSync(
      ListPersonalApiTokensResponseSchema,
    )({
      status: "success",
      data: {
        items: [
          {
            id: "token-1",
            name: "Local CLI",
            identifier: "dxu_abcd1234",
            scopes: ["projects:read"],
            createdAt: "2026-08-23T12:00:00.000Z",
          },
        ],
      },
    });
    expect(JSON.stringify(listed)).not.toContain(created.data.plaintext);
    expect(JSON.stringify(listed)).not.toContain("hash");
  });

  it("exposes only coarse session metadata", () => {
    const response = Schema.decodeUnknownSync(
      ListBrowserSessionsResponseSchema,
    )({
      status: "success",
      data: {
        items: [
          {
            id: "session-1",
            device: "Chrome on macOS",
            network: "203.0.113.x",
            isCurrent: true,
            createdAt: "2026-08-23T12:00:00.000Z",
            lastActiveAt: "2026-08-23T12:01:00.000Z",
            expiresAt: "2026-08-30T12:00:00.000Z",
          },
        ],
      },
    });
    expect(JSON.stringify(response)).not.toContain("sessionToken");
    expect(JSON.stringify(response)).not.toContain("203.0.113.42");
  });
});
