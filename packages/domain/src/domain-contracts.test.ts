import { DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Page, PageRequest } from "./pagination/page.js";
import { Timestamp } from "./persistence/timestamp.js";
import {
  CreateProjectInput,
  isValidProjectName,
  Project,
  ProjectName,
  ProjectNameInput,
} from "./projects/project.js";
import { ProjectId } from "./projects/project-id.js";
import { defaultThreadModelSelection } from "./settings/model-routing.js";
import { CreateThreadInput, Thread } from "./threads/thread.js";
import { ThreadId } from "./threads/thread-id.js";
import { UserId } from "./users/user-id.js";

const encodedProject = {
  id: "prj_00000000-0000-4000-8000-000000000001",
  ownerUserId: "owner-a",
  name: "Project",
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

describe("public domain schemas", () => {
  it("encodes and decodes identifiers and timestamps", () => {
    for (const [schema, value] of [
      [UserId, "owner-a"],
      [ProjectId, encodedProject.id],
      [ThreadId, "thr_00000000-0000-4000-8000-000000000001"],
    ] as const) {
      const decoded = Schema.decodeUnknownSync(schema)(value);
      expect(Schema.encodeSync(schema)(decoded)).toBe(value);
    }

    const timestamp = Schema.decodeUnknownSync(Timestamp)(
      encodedProject.createdAt,
    );
    expect(DateTime.formatIso(timestamp)).toBe(encodedProject.createdAt);
    expect(Schema.encodeSync(Timestamp)(timestamp)).toBe(
      encodedProject.createdAt,
    );
  });

  it("encodes and decodes Project contracts", () => {
    const input = Schema.decodeUnknownSync(CreateProjectInput)({
      ownerUserId: encodedProject.ownerUserId,
      name: encodedProject.name,
      configuration: encodedProject.configuration,
    });
    expect(Schema.encodeSync(CreateProjectInput)(input)).toEqual({
      ownerUserId: encodedProject.ownerUserId,
      name: encodedProject.name,
      configuration: encodedProject.configuration,
    });
    expect(
      Schema.encodeSync(Project)(
        Schema.decodeUnknownSync(Project)(encodedProject),
      ),
    ).toEqual(encodedProject);
    expect(() => Schema.decodeUnknownSync(ProjectName)("")).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProjectName)("x".repeat(64)),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProjectName)("x".repeat(65)),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProjectNameInput)("has spaces"),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(ProjectNameInput)("x")).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProjectNameInput)("dx"),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProjectNameInput)("valid.name-_1"),
    ).not.toThrow();
    expect(isValidProjectName(" valid.name-_1 ")).toBe(true);
    expect(isValidProjectName("x".repeat(65))).toBe(false);
  });

  it("encodes and decodes Thread and page contracts", () => {
    const encodedThread = {
      id: "thr_00000000-0000-4000-8000-000000000001",
      title: "Test thread",
      projectId: encodedProject.id,
      ownerUserId: encodedProject.ownerUserId,
      agentInstructions: { content: "", revision: 0, version: 1 },
      selection: defaultThreadModelSelection(),
      plugins: [],
      skills: [],
      createdAt: encodedProject.createdAt,
      updatedAt: encodedProject.updatedAt,
      lastActivityAt: encodedProject.updatedAt,
      activityStatus: "idle",
      lifecycleState: "active",
    };
    const input = Schema.decodeUnknownSync(CreateThreadInput)({
      title: encodedThread.title,
      projectId: encodedThread.projectId,
      ownerUserId: encodedThread.ownerUserId,
      agentInstructions: encodedThread.agentInstructions,
      selection: encodedThread.selection,
      plugins: encodedThread.plugins,
      skills: encodedThread.skills,
    });
    expect(Schema.encodeSync(CreateThreadInput)(input)).toEqual({
      title: encodedThread.title,
      projectId: encodedThread.projectId,
      ownerUserId: encodedThread.ownerUserId,
      agentInstructions: encodedThread.agentInstructions,
      selection: encodedThread.selection,
      plugins: encodedThread.plugins,
      skills: encodedThread.skills,
    });
    const thread = Schema.decodeUnknownSync(Thread)(encodedThread);
    expect(Schema.encodeSync(Thread)(thread)).toEqual(encodedThread);
    expect(Schema.decodeUnknownSync(PageRequest)({})).toEqual({});
    expect(
      Schema.encodeSync(Page(Thread))(
        Schema.decodeUnknownSync(Page(Thread))({ items: [encodedThread] }),
      ),
    ).toEqual({ items: [encodedThread] });
  });
});
