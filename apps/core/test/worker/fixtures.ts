import {
  defaultThreadModelSelection,
  PersonalAgentInstructionsSnapshot,
  Project,
  type ProjectId,
  Thread,
  type UserId,
} from "@dx/domain";
import { Schema } from "effect";

export const project = (
  id: string,
  ownerUserId: UserId,
  name: string,
  createdAt = "2026-08-20T12:00:00.000Z",
) =>
  Schema.decodeUnknownSync(Project)({
    id,
    ownerUserId,
    name,
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
    createdAt,
    updatedAt: createdAt,
  });

export const thread = (
  id: string,
  projectId: ProjectId,
  ownerUserId: UserId,
  createdAt = "2026-08-20T12:00:00.000Z",
  agentInstructions = Schema.decodeUnknownSync(
    PersonalAgentInstructionsSnapshot,
  )({ content: "", revision: 0, version: 1 }),
) =>
  Schema.decodeUnknownSync(Thread)({
    id,
    title: "Test thread",
    projectId,
    ownerUserId,
    agentInstructions,
    selection: defaultThreadModelSelection(),
    plugins: [],
    skills: [],
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
    activityStatus: "idle",
    lifecycleState: "active",
  });
