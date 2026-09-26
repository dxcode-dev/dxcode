import {
  PersonalAgentInstructions,
  PersonalAgentInstructionsRepository,
  Principal,
  UpdatePersonalAgentInstructionsInput,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit, type SettingsAuditEvent } from "../audit.js";
import { PersonalAgentInstructionsService } from "./service.js";

const principal = Schema.decodeUnknownSync(Principal)({
  userId: "instructions-owner",
  credentialScopes: ["personal"],
});
const current = Schema.decodeUnknownSync(PersonalAgentInstructions)({
  userId: principal.userId,
  content: "Prefer small changes.",
  revision: 2,
  version: 1,
  updatedAt: "2026-08-22T12:00:00.000Z",
});

describe("PersonalAgentInstructionsService", () => {
  it("derives ownership from the principal and audits no instruction content", async () => {
    const requests: Array<unknown> = [];
    const events: Array<SettingsAuditEvent> = [];
    const repository = PersonalAgentInstructionsRepository.of({
      findOwnedByUser: () => Effect.succeed(current),
      updateOwnedByUser: (userId, input) => {
        requests.push({ userId, input });
        return Effect.succeed({
          ...current,
          content: input.content,
          revision: Schema.decodeUnknownSync(
            PersonalAgentInstructions.fields.revision,
          )(current.revision + 1),
        });
      },
    });
    const audit = SettingsAudit.of({
      record: (event) => Effect.sync(() => events.push(event)),
    });
    const layer = PersonalAgentInstructionsService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(PersonalAgentInstructionsRepository, repository),
          Layer.succeed(SettingsAudit, audit),
        ),
      ),
    );
    const input = Schema.decodeUnknownSync(
      UpdatePersonalAgentInstructionsInput,
    )({
      content: "PRIVATE-INSTRUCTION-CONTENT",
      expectedRevision: 2,
    });

    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* PersonalAgentInstructionsService;
        return yield* service.update(principal, input, "request-1");
      }).pipe(Effect.provide(layer)),
    );

    expect(requests).toEqual([{ userId: principal.userId, input }]);
    expect(updated).toMatchObject({
      content: "PRIVATE-INSTRUCTION-CONTENT",
      revision: 3,
    });
    expect(events).toEqual([
      {
        action: "personal_agent_instructions.update",
        scope: "personal",
        outcome: "success",
        requestId: "request-1",
        userId: principal.userId,
        fields: ["instructions"],
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE-INSTRUCTION-CONTENT");
  });
});
