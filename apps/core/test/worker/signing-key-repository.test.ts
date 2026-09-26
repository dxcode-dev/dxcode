import { env } from "cloudflare:test";
import {
  PersonalVerificationKey,
  PersistenceUnavailable,
  SigningKeyConflict,
  SigningKeyRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsPersistenceLogger } from "../../src/logging.js";
import { SigningKeyRepositoryD1 } from "../../src/settings/keys/repository-d1.js";

const userId = Schema.decodeUnknownSync(UserId)("signing-key-repository-user");
const key = Schema.decodeUnknownSync(PersonalVerificationKey)({
  id: "vrf_attempted",
  userId,
  name: "Attempted key",
  publicKey: `ssh-ed25519 ${"A".repeat(68)}`,
  fingerprint: `SHA256:${"A".repeat(43)}`,
  createdAt: "2026-09-03T10:00:00.000Z",
});

const runInsert = (db: D1Database) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* SigningKeyRepository;
      yield* repository.insertVerification(key);
    }).pipe(Effect.provide(SigningKeyRepositoryD1(db))),
  );

const rejectingInsertDb = (
  behavior: "before-commit" | "after-commit",
  probeFails = false,
) =>
  new Proxy(env.DB, {
    get(target, property, receiver) {
      if (property !== "prepare")
        return Reflect.get(target, property, receiver);
      return (query: string) => {
        const statement = target.prepare(query);
        if (
          probeFails &&
          query.includes("WHERE id = ? OR (user_id = ? AND fingerprint = ?)")
        ) {
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "bind") {
                return Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementReceiver,
                );
              }
              return () => ({
                first: () => Promise.reject(new Error("probe unavailable")),
              });
            },
          });
        }
        if (!query.includes("INSERT INTO personal_verification_key")) {
          return statement;
        }
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== "bind") {
              return Reflect.get(
                statementTarget,
                statementProperty,
                statementReceiver,
              );
            }
            return (...values: unknown[]) => {
              const bound = statementTarget.bind(...values);
              return new Proxy(bound, {
                get(boundTarget, boundProperty, boundReceiver) {
                  if (boundProperty !== "run") {
                    return Reflect.get(
                      boundTarget,
                      boundProperty,
                      boundReceiver,
                    );
                  }
                  return async () => {
                    if (behavior === "after-commit") await boundTarget.run();
                    throw new Error("insert response rejected");
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as D1Database;

const insertExisting = async (
  id: string,
  status: "active" | "revoked",
  overrides: {
    readonly name?: string;
    readonly fingerprint?: string;
    readonly createdAt?: string;
  } = {},
) => {
  const revoked = status === "revoked";
  await env.DB.prepare(
    `INSERT INTO personal_verification_key (
       id, user_id, name, algorithm, public_key, fingerprint,
       status, created_at, revoked_at
     ) VALUES (?, ?, ?, 'ssh-ed25519', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      overrides.name ?? "Older key",
      key.publicKey,
      overrides.fingerprint ?? key.fingerprint,
      status,
      overrides.createdAt ?? "2026-09-02T10:00:00.000Z",
      revoked ? "2026-09-02T11:00:00.000Z" : null,
    )
    .run();
};

beforeEach(async () => {
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(userId, "Signing Key Owner", "signing-repository@example.com", 1, 1)
    .run();
});

afterEach(() => vi.restoreAllMocks());

describe("SigningKeyRepositoryD1.insertVerification", () => {
  it("inserts a verification key when D1 is healthy", async () => {
    await expect(runInsert(env.DB)).resolves.toBeUndefined();
  });

  it("preserves the insert PersistenceUnavailable when no row committed", async () => {
    await expect(
      runInsert(rejectingInsertDb("before-commit")),
    ).rejects.toMatchObject({
      _tag: "PersistenceUnavailable",
      operation: "settings.signingKeys.insertVerification",
    });
  });

  it.each(["active", "revoked"] as const)(
    "reports an older %s row with the fingerprint as a conflict",
    async (status) => {
      await insertExisting("vrf_older", status);
      await expect(
        runInsert(rejectingInsertDb("before-commit")),
      ).rejects.toBeInstanceOf(SigningKeyConflict);
    },
  );

  it("reports a primary-key collision with another fingerprint as a conflict", async () => {
    await insertExisting(key.id, "active", {
      fingerprint: `SHA256:${"B".repeat(43)}`,
    });
    await expect(
      runInsert(rejectingInsertDb("before-commit")),
    ).rejects.toBeInstanceOf(SigningKeyConflict);
  });

  it("reports a matching ID and fingerprint with different payload as a conflict", async () => {
    await insertExisting(key.id, "active");
    await expect(
      runInsert(rejectingInsertDb("before-commit")),
    ).rejects.toBeInstanceOf(SigningKeyConflict);
  });

  it("treats a rejected insert as successful when the attempted row committed", async () => {
    const persistence = vi
      .spyOn(settingsPersistenceLogger, "info")
      .mockImplementation(() => {});
    await expect(
      runInsert(rejectingInsertDb("after-commit")),
    ).resolves.toBeUndefined();
    expect(persistence).toHaveBeenCalledWith(
      "Verification key persistence succeeded.",
      expect.objectContaining({ verificationKeyId: key.id }),
    );
  });

  it("propagates PersistenceUnavailable from the outcome probe", async () => {
    const error = await runInsert(
      rejectingInsertDb("before-commit", true),
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PersistenceUnavailable);
    expect(error).toMatchObject({
      operation: "settings.signingKeys.findVerificationInsertOutcome",
    });
  });
});
