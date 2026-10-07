import { DateTime, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { UserId } from "../users/user-id.js";
import {
  createProject,
  Project,
  projectAdditionalRepositoryFromUrl,
} from "./project.js";
import { ProjectId } from "./project-id.js";

const ownerUserId = Schema.decodeUnknownSync(UserId)("user-1");
const configuration = {
  shipAction: "ship",
  commitAuthor: {
    preference: "dx",
    name: "dx",
    email: "noreply@dx.local",
  },
  signingPreference: "disabled",
  runnerProfileId: "e2b-default",
  publicCodeEnabled: false,
} as const;

describe("Project domain", () => {
  it("validates ID formats", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProjectId)(
        "prj_00000000-0000-4000-8000-000000000001",
      ),
    ).not.toThrow();
    expect(() => Schema.decodeUnknownSync(ProjectId)("project-1")).toThrow();
  });

  it("creates unique opaque IDs and one timestamp per entity", async () => {
    const [first, second] = await Effect.runPromise(
      Effect.all([
        createProject({ ownerUserId, name: "First", configuration }),
        createProject({ ownerUserId, name: "Second", configuration }),
      ]),
    );

    expect(first.id).not.toBe(second.id);
    expect(DateTime.formatIso(first.createdAt)).toBe(
      DateTime.formatIso(first.updatedAt),
    );
    expect(Schema.encodeSync(Project)(first)).toMatchObject({
      id: first.id,
      ownerUserId: "user-1",
      name: "First",
    });
  });

  it("derives additional repository identity from canonical URLs", () => {
    expect(
      projectAdditionalRepositoryFromUrl("https://GitHub.com/acme/api.git"),
    ).toEqual({
      provider: "github",
      fullName: "acme/api",
      webUrl: "https://github.com/acme/api",
      cloneUrl: "https://github.com/acme/api.git",
    });
    expect(
      projectAdditionalRepositoryFromUrl("https://bitbucket.org/team/lib"),
    ).toMatchObject({ provider: "bitbucket", fullName: "team/lib" });
    expect(
      projectAdditionalRepositoryFromUrl("https://gitlab.com/group/sub/tool"),
    ).toMatchObject({ provider: "git", fullName: "group/sub/tool" });
    expect(
      projectAdditionalRepositoryFromUrl("https://token@github.com/acme/api"),
    ).toBeUndefined();
    expect(
      projectAdditionalRepositoryFromUrl("git@github.com:acme/api.git"),
    ).toBeUndefined();
  });
});
