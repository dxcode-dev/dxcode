import {
  EnvironmentVariableName,
  EnvironmentVariableRepository,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { loadConfigEncryptionKeyring } from "../../settings/config-encryption.js";
import { decryptEnvironmentVariable } from "../../settings/environment-variables/encryption.js";
import { EnvironmentVariableRepositoryD1 } from "../../settings/environment-variables/repository-d1.js";
import type { ServiceInstall } from "./installs.js";

/**
 * The secrets an install's service receives as environment variables: each
 * name `permissions.secrets` grants, read from the install's own scope in
 * Secrets & Env Vars (a personal install: the person's; a workspace
 * install: the workspace's), as the install review listed them. A service
 * has no Thread, so no Project secret is a fallback. A personal secret is
 * skipped when the person's workspace turns personal secrets off for
 * plugins. A name with no usable secret is left out.
 */
export const serviceSecrets = async (
  bindings: Bindings,
  db: D1Database,
  install: ServiceInstall,
): Promise<Record<string, string>> => {
  const names = install.code.permissions.secrets;
  if (names.length === 0) return {};
  if (install.scope === "personal") {
    const denied = await db
      .prepare(
        `SELECT 1 FROM member
           JOIN workspace_policy policy
             ON policy.workspace_id = member.organizationId
          WHERE member.userId = ? AND policy.allow_personal_secret_overrides = 0
          LIMIT 1`,
      )
      .bind(install.targetId)
      .first();
    if (denied !== null) return {};
  }
  const own = { scope: install.scope, id: install.targetId } as const;
  const values = await Effect.runPromise(
    Effect.gen(function* () {
      const variables = yield* EnvironmentVariableRepository;
      const keyring = yield* loadConfigEncryptionKeyring(bindings);
      const out: Record<string, string> = {};
      for (const raw of names) {
        const name = Schema.decodeUnknownOption(EnvironmentVariableName)(raw);
        if (Option.isNone(name)) continue;
        const found = yield* variables.findByName(own as never, name.value);
        if (
          Option.isNone(found) ||
          found.value.kind !== "secret" ||
          !found.value.enabled
        )
          continue;
        out[raw] = yield* decryptEnvironmentVariable(
          keyring,
          {
            id: found.value.id,
            target: found.value.target,
            name: found.value.name,
            kind: found.value.kind,
          },
          found.value.envelope,
        );
      }
      return out;
    }).pipe(
      Effect.provide(
        EnvironmentVariableRepositoryD1(db).pipe(
          Layer.provide(D1Client.layer({ db })),
        ),
      ),
    ),
  );
  return values;
};
