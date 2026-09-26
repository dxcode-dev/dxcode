import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SourceControlAdapterDescriptor,
  SourceControlFailure,
  SourceControlProviderId,
  ThreadSourceAuthority,
} from "./source-control.js";

describe("source-control contracts", () => {
  it("keeps unsupported persisted provider IDs decodable", () => {
    for (const provider of ["github", "gitlab", "forgejo"]) {
      expect(Schema.decodeUnknownSync(SourceControlProviderId)(provider)).toBe(
        provider,
      );
    }
  });

  it("rejects undeclared adapter capabilities", () => {
    expect(() =>
      Schema.decodeUnknownSync(SourceControlAdapterDescriptor)({
        contractVersion: 1,
        provider: "github",
        availability: "enabled",
        displayName: "GitHub",
        capabilities: ["credential-export"],
      }),
    ).toThrow();
  });

  it("round-trips typed failures without provider response details", () => {
    const failure = Schema.decodeUnknownSync(SourceControlFailure)({
      _tag: "SourceControlAccessDenied",
      reason: "repository-access-removed",
      action: "reconfigure",
    });
    expect(Schema.encodeSync(SourceControlFailure)(failure)).toEqual({
      _tag: "SourceControlAccessDenied",
      reason: "repository-access-removed",
      action: "reconfigure",
    });
  });

  it("limits Thread source installation IDs to 1 through 256 characters", () => {
    const authority = {
      threadId: "thr_00000000-0000-4000-8000-000000000249",
      grantId: "grant-1",
      providerRepositoryId: "repository-1",
      authorizationEpoch: 1,
      installationEpoch: 0,
      policyRevision: 0,
      privateSubmoduleRepositoryIds: [],
    };
    for (const installationId of ["i", "i".repeat(256)]) {
      expect(
        Schema.decodeUnknownSync(ThreadSourceAuthority)({
          ...authority,
          installationId,
        }).installationId,
      ).toBe(installationId);
    }
    for (const installationId of ["", "i".repeat(257)]) {
      expect(() =>
        Schema.decodeUnknownSync(ThreadSourceAuthority)({
          ...authority,
          installationId,
        }),
      ).toThrow();
    }
  });
});
