import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CreateWorkspaceRequestSchema,
  GetWorkspaceProfileResponseSchema,
  UpdateWorkspaceProfileRequestSchema,
  WorkspaceProfileErrorResponseSchema,
} from "./workspace-profile.js";

const strict = { onExcessProperty: "error" } as const;

describe("workspace profile API schemas", () => {
  it("round-trips branded identity, profile, role, and lifecycle state", () => {
    expect(
      Schema.decodeUnknownSync(GetWorkspaceProfileResponseSchema)({
        status: "success",
        data: {
          id: "stable-workspace-id",
          displayName: "DX Team",
          shortName: "dx-team",
          lifecycleState: "active",
          revision: 2,
          role: "admin",
        },
      }),
    ).toMatchObject({
      data: {
        id: "stable-workspace-id",
        shortName: "dx-team",
        lifecycleState: "active",
        revision: 2,
        role: "admin",
      },
    });
  });

  it("validates and round-trips the expected profile revision", () => {
    const request = {
      displayName: "Renamed Team",
      shortName: "renamed-team",
      expectedRevision: 2,
    };
    expect(
      Schema.encodeUnknownSync(UpdateWorkspaceProfileRequestSchema)(
        Schema.decodeUnknownSync(UpdateWorkspaceProfileRequestSchema)(request),
      ),
    ).toEqual(request);
    expect(() =>
      Schema.decodeUnknownSync(UpdateWorkspaceProfileRequestSchema)({
        ...request,
        expectedRevision: -1,
      }),
    ).toThrow();
  });

  it("keeps creation limited to profile fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(
        CreateWorkspaceRequestSchema,
        strict,
      )({
        displayName: "DX Team",
        shortName: "dx-team",
        ownerId: "other-user",
      }),
    ).toThrow();
  });

  it.each([
    {
      status: "error",
      data: {
        code: "WORKSPACE_MEMBERSHIP_EXISTS",
        message: "This user already belongs to a workspace.",
        requestId: "request-1",
      },
    },
    {
      status: "error",
      data: {
        code: "WORKSPACE_PROFILE_CONFLICT",
        message: "Workspace profile changed since you started editing.",
        requestId: "request-3",
        currentRevision: 4,
      },
    },
    {
      status: "error",
      data: {
        code: "WORKSPACE_SHORT_NAME_UNAVAILABLE",
        message: "That workspace short name is already in use.",
        requestId: "request-2",
        fieldErrors: [
          { field: "shortName", message: "Choose a different short name." },
        ],
      },
    },
  ])("decodes typed invariant and uniqueness errors", (response) => {
    expect(
      Schema.decodeUnknownSync(WorkspaceProfileErrorResponseSchema)(response),
    ).toEqual(response);
  });
});
