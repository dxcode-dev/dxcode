import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  GetProjectInvalidRequestResponseSchema,
  GetProjectNotFoundResponseSchema,
  GetProjectParamsSchema,
  GetProjectPersistenceUnavailableResponseSchema,
  GetProjectResponseSchema,
} from "./get-project.js";

const projectId = "prj_00000000-0000-4000-8000-000000000071";
const project = {
  id: projectId,
  name: "product-api",
  configuration: {
    shipAction: "ship",
    commitAuthor: {
      preference: "dx",
      name: "dx",
      email: "noreply@dx.local",
    },
    signingPreference: "disabled",
    runnerProfileId: "e2b-default",
    publicCodeEnabled: false,
  },
  revision: 0,
  createdAt: "2026-08-20T12:00:00.000Z",
  updatedAt: "2026-08-20T12:00:00.000Z",
};

describe("Get Project contract", () => {
  it("decodes only a canonical ProjectId parameter", () => {
    expect(
      Schema.decodeUnknownSync(GetProjectParamsSchema)({ projectId }),
    ).toEqual({
      projectId,
    });
    expect(() =>
      Schema.decodeUnknownSync(GetProjectParamsSchema)({
        projectId: "invalid",
      }),
    ).toThrow();
  });

  it("encodes the public response without ownership", () => {
    const response = { status: "success" as const, data: project };
    const encoded = Schema.encodeUnknownSync(GetProjectResponseSchema)(
      Schema.decodeUnknownSync(GetProjectResponseSchema)(response),
    );
    expect(encoded).toEqual(response);
    expect(JSON.stringify(encoded)).not.toContain("ownerUserId");
  });

  it.each([
    [
      GetProjectInvalidRequestResponseSchema,
      "INVALID_REQUEST",
      "Request validation failed.",
    ],
    [
      GetProjectNotFoundResponseSchema,
      "PROJECT_NOT_FOUND",
      "Project not found.",
    ],
    [
      GetProjectPersistenceUnavailableResponseSchema,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
    ],
  ] as const)("keeps the %s error literal exact", (schema, code, message) => {
    expect(
      Schema.decodeUnknownSync(schema)({
        status: "error",
        data: { code, message, requestId: "req-project" },
      }).data.code,
    ).toBe(code);
  });
});
