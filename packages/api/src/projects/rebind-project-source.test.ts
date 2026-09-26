import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  RebindProjectSourceRequestSchema,
  RebindProjectSourceResponseSchema,
} from "./rebind-project-source.js";

describe("RebindProjectSource contracts", () => {
  it("accepts only credential-free stable source identity", () => {
    expect(
      Schema.decodeUnknownSync(RebindProjectSourceRequestSchema)({
        revision: 3,
        grantId: "grant-1",
        providerRepositoryId: "123",
      }),
    ).toEqual({
      revision: 3,
      grantId: "grant-1",
      providerRepositoryId: "123",
    });
  });

  it("limits workspace IDs to 1 through 256 characters", () => {
    for (const workspaceId of ["w", "w".repeat(256)]) {
      expect(
        Schema.decodeUnknownSync(RebindProjectSourceRequestSchema)({
          revision: 3,
          grantId: "grant-1",
          providerRepositoryId: "123",
          workspaceId,
        }).workspaceId,
      ).toBe(workspaceId);
    }
    for (const workspaceId of ["", "w".repeat(257)]) {
      expect(() =>
        Schema.decodeUnknownSync(RebindProjectSourceRequestSchema)({
          revision: 3,
          grantId: "grant-1",
          providerRepositoryId: "123",
          workspaceId,
        }),
      ).toThrow();
    }
  });

  it("uses the shared Project response envelope", () => {
    expect(RebindProjectSourceResponseSchema).toBeDefined();
  });
});
