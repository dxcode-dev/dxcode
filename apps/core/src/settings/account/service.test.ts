import {
  PersonalAccount,
  PersonalAccountRepository,
  Principal,
  UpdatePersonalAccountInput,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit, type SettingsAuditEvent } from "../audit.js";
import { PersonalAccountService } from "./service.js";

const principal = Schema.decodeUnknownSync(Principal)({
  userId: "account-owner",
  credentialScopes: ["personal"],
});
const account = Schema.decodeUnknownSync(PersonalAccount)({
  userId: principal.userId,
  displayName: "Account Owner",
  username: "account-owner",
  email: "owner@example.com",
  emailVerified: true,
  identityAuthority: "cloudflare-access",
  threadCount: 12,
  appearance: "dark",
  palette: "daydream",
  terminalTheme: "github",
});

describe("PersonalAccountService", () => {
  it("uses principal ownership and audits only changed local profile fields", async () => {
    const reads: Array<string> = [];
    const updates: Array<unknown> = [];
    const events: Array<SettingsAuditEvent> = [];
    const repository = PersonalAccountRepository.of({
      findOwnedByUser: (userId) => {
        reads.push(userId);
        return Effect.succeed(account);
      },
      updateOwnedByUser: (userId, input) => {
        updates.push({ userId, input });
        return Effect.succeed({ ...account, ...input });
      },
      updateAppearanceOwnedByUser: (userId, input) => {
        updates.push({ userId, input });
        return Effect.succeed({ ...account, ...input });
      },
    });
    const audit = SettingsAudit.of({
      record: (event) => Effect.sync(() => events.push(event)),
    });
    const layer = PersonalAccountService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(PersonalAccountRepository, repository),
          Layer.succeed(SettingsAudit, audit),
        ),
      ),
    );
    const input = Schema.decodeUnknownSync(UpdatePersonalAccountInput)({
      displayName: account.displayName,
      username: "new-owner",
    });

    const updated = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* PersonalAccountService;
        return yield* service.update(principal, input, "request-1");
      }).pipe(Effect.provide(layer)),
    );

    expect(reads).toEqual([principal.userId]);
    expect(updates).toEqual([{ userId: principal.userId, input }]);
    expect(updated.username).toBe("new-owner");
    expect(events).toEqual([
      {
        action: "personal_account.update",
        scope: "personal",
        outcome: "success",
        requestId: "request-1",
        userId: principal.userId,
        fields: ["username"],
      },
    ]);
  });
});
