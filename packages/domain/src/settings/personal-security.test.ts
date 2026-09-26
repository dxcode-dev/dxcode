import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  normalizePersonalApiTokenName,
  PersonalApiTokenScopes,
  personalApiTokenScopes,
} from "./personal-security.js";

describe("personal security domain", () => {
  it("defines the complete bounded dx token scope vocabulary", () => {
    expect(personalApiTokenScopes).toEqual([
      "projects:read",
      "projects:write",
      "threads:read",
      "threads:write",
      "agents:access",
      "settings:read",
      "settings:write",
    ]);
    expect(
      Schema.decodeUnknownSync(PersonalApiTokenScopes)([
        "projects:read",
        "agents:access",
      ]),
    ).toEqual(["projects:read", "agents:access"]);
    expect(() =>
      Schema.decodeUnknownSync(PersonalApiTokenScopes)(["projects:delete"]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PersonalApiTokenScopes)([
        "projects:read",
        "projects:read",
      ]),
    ).toThrow();
  });

  it("normalizes token names without inventing identity", () => {
    expect(normalizePersonalApiTokenName("  Local CLI  ")).toBe("Local CLI");
  });
});
