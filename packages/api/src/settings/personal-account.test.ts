import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetPersonalAccountResponseSchema,
  PersonalAccountErrorResponseSchema,
  UpdatePersonalAccountRequestSchema,
} from "./personal-account.js";

const strict = { onExcessProperty: "error" } as const;

describe("personal account API schemas", () => {
  it("round-trips the editable profile and read-only identity state", () => {
    expect(
      Schema.decodeUnknownSync(GetPersonalAccountResponseSchema)({
        status: "success",
        data: {
          displayName: "Rowan Example",
          username: "rowan-example",
          email: "rowan@example.com",
          emailVerified: true,
          identityAuthority: "cloudflare-access",
          threadCount: 12,
          appearance: "light",
          palette: "deadpan",
          terminalTheme: "gruvbox",
        },
      }),
    ).toMatchObject({
      data: {
        username: "rowan-example",
        emailVerified: true,
        identityAuthority: "cloudflare-access",
        threadCount: 12,
        appearance: "light",
        palette: "deadpan",
        terminalTheme: "gruvbox",
      },
    });
  });

  it("keeps authoritative identity fields out of the update contract", () => {
    expect(() =>
      Schema.decodeUnknownSync(
        UpdatePersonalAccountRequestSchema,
        strict,
      )({
        displayName: "Rowan",
        username: "rowan",
        email: "other@example.com",
      }),
    ).toThrow();
  });

  it.each([
    {
      status: "error",
      data: {
        code: "INVALID_ACCOUNT_PROFILE",
        message: "Account profile validation failed.",
        requestId: "request-1",
        fieldErrors: [{ field: "username", message: "Use a valid username." }],
      },
    },
    {
      status: "error",
      data: {
        code: "USERNAME_UNAVAILABLE",
        message: "That username is already in use.",
        requestId: "request-2",
        fieldErrors: [
          { field: "username", message: "Choose a different username." },
        ],
      },
    },
  ])("decodes typed validation and conflict feedback", (response) => {
    expect(
      Schema.decodeUnknownSync(PersonalAccountErrorResponseSchema)(response),
    ).toEqual(response);
  });
});
