import {
  PersonalAgentInstructionsRepository,
  UpdatePersonalAgentInstructionsInput,
  UserId,
} from "@dx/domain";
import { env } from "cloudflare:test";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsPersistenceLogger } from "../../src/logging.js";
import { runRepositories } from "./runtime.js";

const owner = Schema.decodeUnknownSync(UserId)("instructions-repository-owner");
const other = Schema.decodeUnknownSync(UserId)("instructions-repository-other");

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Instructions Owner", "instructions-owner@example.com", 1, 1),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(other, "Instructions Other", "instructions-other@example.com", 1, 1),
  ]);
});

const updateInput = (content: string, expectedRevision: number) =>
  Schema.decodeUnknownSync(UpdatePersonalAgentInstructionsInput)({
    content,
    expectedRevision,
  });

describe("PersonalAgentInstructionsRepository D1", () => {
  it("isolates owners, detects stale revisions, resets, and omits content from logs", async () => {
    const privateContent = "PRIVATE-REPOSITORY-INSTRUCTION";
    const info = vi
      .spyOn(settingsPersistenceLogger, "info")
      .mockImplementation(() => {});

    await runRepositories(
      Effect.gen(function* () {
        const repository = yield* PersonalAgentInstructionsRepository;
        expect(yield* repository.findOwnedByUser(owner)).toMatchObject({
          content: "",
          revision: 0,
          version: 1,
        });

        const saved = yield* repository.updateOwnedByUser(
          owner,
          updateInput(privateContent, 0),
        );
        expect(saved).toMatchObject({ content: privateContent, revision: 1 });
        expect(yield* repository.findOwnedByUser(other)).toMatchObject({
          content: "",
          revision: 0,
        });

        const conflict = yield* Effect.flip(
          repository.updateOwnedByUser(owner, updateInput("stale", 0)),
        );
        expect(conflict).toMatchObject({
          _tag: "PersonalAgentInstructionsRevisionConflict",
          expectedRevision: 0,
          actualRevision: 1,
        });

        const reset = yield* repository.updateOwnedByUser(
          owner,
          updateInput("", 1),
        );
        expect(reset).toMatchObject({ content: "", revision: 2 });
      }),
    );

    expect(JSON.stringify(info.mock.calls)).not.toContain(privateContent);
    expect(info).toHaveBeenCalledWith(
      "Personal agent instructions update succeeded.",
      expect.objectContaining({ revision: 1 }),
    );
    info.mockRestore();
  });
});
