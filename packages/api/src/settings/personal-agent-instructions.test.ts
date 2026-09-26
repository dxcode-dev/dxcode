import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetPersonalAgentInstructionsResponseSchema,
  PersonalAgentInstructionsErrorResponseSchema,
  UpdatePersonalAgentInstructionsRequestSchema,
} from "./personal-agent-instructions.js";

const strict = { onExcessProperty: "error" } as const;

describe("personal agent instructions API schemas", () => {
  it("round-trips content with revision, version, and update metadata", () => {
    const response = {
      status: "success" as const,
      data: {
        instructions: "Prefer focused changes.",
        revision: 3,
        version: 1 as const,
        updatedAt: "2026-08-22T12:00:00.000Z",
      },
    };
    expect(
      Schema.encodeUnknownSync(GetPersonalAgentInstructionsResponseSchema)(
        Schema.decodeUnknownSync(GetPersonalAgentInstructionsResponseSchema)(
          response,
        ),
      ),
    ).toEqual(response);
  });

  it("strictly limits mutations to content and an expected revision", () => {
    expect(
      Schema.decodeUnknownSync(
        UpdatePersonalAgentInstructionsRequestSchema,
        strict,
      )({ instructions: "Be concise.", expectedRevision: 2 }),
    ).toEqual({ instructions: "Be concise.", expectedRevision: 2 });
    expect(() =>
      Schema.decodeUnknownSync(
        UpdatePersonalAgentInstructionsRequestSchema,
        strict,
      )({ instructions: "Be concise.", expectedRevision: 2, version: 2 }),
    ).toThrow();
  });

  it("decodes typed field and optimistic-conflict feedback", () => {
    const invalid = {
      status: "error",
      data: {
        code: "INVALID_AGENT_INSTRUCTIONS",
        message: "Agent instructions validation failed.",
        requestId: "request-invalid",
        fieldErrors: [
          {
            field: "instructions",
            message: "Enter no more than 10,000 characters.",
          },
        ],
      },
    };
    const conflict = {
      status: "error",
      data: {
        code: "AGENT_INSTRUCTIONS_REVISION_CONFLICT",
        message:
          "Agent instructions changed in another session. Reload before saving.",
        requestId: "request-conflict",
        currentRevision: 4,
      },
    };
    expect(
      Schema.decodeUnknownSync(PersonalAgentInstructionsErrorResponseSchema)(
        invalid,
      ),
    ).toEqual(invalid);
    expect(
      Schema.decodeUnknownSync(PersonalAgentInstructionsErrorResponseSchema)(
        conflict,
      ),
    ).toEqual(conflict);
  });
});
