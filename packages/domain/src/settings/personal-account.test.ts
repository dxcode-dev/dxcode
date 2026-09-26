import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  normalizePersonalAccountDisplayName,
  normalizePersonalAccountUsername,
  PersonalAccount,
  PersonalAccountDisplayName,
  PersonalAccountUsername,
} from "./personal-account.js";

describe("personal account domain", () => {
  it("normalizes display names and handles before validation", () => {
    expect(normalizePersonalAccountDisplayName("  Rowan Example  ")).toBe(
      "Rowan Example",
    );
    expect(normalizePersonalAccountUsername("  @Rowan-Example  ")).toBe(
      "rowan-example",
    );
  });

  it.each(["rowan", "rowan-2", "a2b"])(
    "accepts normalized username %s",
    (username) => {
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(PersonalAccountUsername)(username),
        ),
      ).toBe(true);
    },
  );

  it.each(["ab", "Rowan", "-rowan", "rowan-", "rowan_example", "a".repeat(33)])(
    "rejects invalid or non-normalized username %s",
    (username) => {
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(PersonalAccountUsername)(username),
        ),
      ).toBe(true);
    },
  );

  it("models local profile fields separately from authoritative identity", () => {
    const account = Schema.decodeUnknownSync(PersonalAccount)({
      userId: "user-1",
      displayName: Schema.decodeUnknownSync(PersonalAccountDisplayName)(
        "Rowan",
      ),
      username: "rowan",
      email: "rowan@example.com",
      emailVerified: true,
      identityAuthority: "cloudflare-access",
      threadCount: 12,
      appearance: "light",
      palette: "deadpan",
      terminalTheme: "gruvbox",
    });

    expect(account).toMatchObject({
      displayName: "Rowan",
      username: "rowan",
      emailVerified: true,
      identityAuthority: "cloudflare-access",
      threadCount: 12,
      appearance: "light",
      palette: "deadpan",
      terminalTheme: "gruvbox",
    });
  });
});
