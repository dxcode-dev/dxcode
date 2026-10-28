import {
  OrbProviderCredentials,
  OrbProviderPreparationProgress,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import {
  type ConfigEncryptionKeyring,
  type ConfigValueEnvelope,
  decryptConfigValue,
  encryptConfigValue,
} from "../../settings/config-encryption.js";
import type { OrbPreparation, OrbPreparationState } from "./connector.js";
import type { ExecutionProviderId } from "./provider.js";

export type OrbConnectionScope = "personal" | "workspace";

export interface OrbConnectionKey {
  readonly scope: OrbConnectionScope;
  readonly targetId: string;
  readonly providerId: ExecutionProviderId;
}

/**
 * A person's or workspace's own provider account and where dx's
 * preparation of it stands (`orb_connection`).
 */
export interface OrbConnection extends OrbConnectionKey {
  readonly configuredAt: string;
  /** The recipe preparation ran for; null before its first step. */
  readonly recipe: string | null;
  readonly account: string | null;
  readonly status: OrbPreparation["status"];
  readonly state: OrbPreparationState;
  readonly progress: OrbPreparation["progress"];
  readonly error: string | null;
  /**
   * The ready version new Threads keep pinning while the connection
   * prepares again (a new recipe, or new credentials for the same account).
   */
  readonly served: OrbServedVersion | null;
  readonly revision: number;
  readonly updatedAt: string;
}

/** What a connection's last ready preparation made, by runner profile ID. */
export interface OrbServedVersion {
  readonly account: string;
  readonly targets: Readonly<Record<string, string>>;
  /** Sizes the account could not run then, with the provider's reason. */
  readonly unavailable?: Readonly<Record<string, string>>;
}

/** The state key the served version is kept under, beside provider state. */
const SERVED_KEY = "$served";

const servedOf = (value: unknown): OrbServedVersion | null => {
  if (typeof value !== "object" || value === null) return null;
  const { account, targets, unavailable } = value as Record<string, unknown>;
  const strings = (record: unknown): record is Record<string, string> =>
    typeof record === "object" &&
    record !== null &&
    Object.values(record).every((entry) => typeof entry === "string");
  if (typeof account !== "string" || !strings(targets)) return null;
  return {
    account,
    targets,
    ...(strings(unavailable) ? { unavailable } : {}),
  };
};

/** Provider state with the served version beside it, for `state_json`. */
const stateJson = (
  state: OrbPreparationState,
  served: OrbServedVersion | null,
) => {
  const { [SERVED_KEY]: _previous, ...rest } = state;
  return JSON.stringify(
    served === null ? rest : { ...rest, [SERVED_KEY]: served },
  );
};

export interface OrbConnectionRow {
  readonly scope: OrbConnectionScope;
  readonly target_id: string;
  readonly provider_id: string;
  readonly configured_at: string;
  readonly recipe: string | null;
  readonly account: string | null;
  readonly status: OrbPreparation["status"];
  readonly state_json: string;
  readonly progress_json: string | null;
  readonly error: string | null;
  readonly revision: number;
  readonly updated_at: string;
}

const decodeProgress = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrbProviderPreparationProgress),
);

const parseState = (json: string): OrbPreparationState => {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as OrbPreparationState)
      : {};
  } catch {
    return {};
  }
};

export const connectionFromRow = (row: OrbConnectionRow): OrbConnection => {
  const progress =
    row.progress_json === null
      ? null
      : Option.getOrNull(decodeProgress(row.progress_json));
  const { [SERVED_KEY]: served, ...state } = parseState(row.state_json);
  return {
    scope: row.scope,
    targetId: row.target_id,
    providerId: row.provider_id as ExecutionProviderId,
    configuredAt: row.configured_at,
    recipe: row.recipe,
    account: row.account,
    status: row.status,
    state,
    progress,
    error: row.error,
    served: servedOf(served),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
};

export const CONNECTION_COLUMNS = `scope, target_id, provider_id, configured_at,
  recipe, account, status, state_json, progress_json, error, revision,
  updated_at`;

/** A connection's envelope, for decrypting its credentials. */
export interface StoredOrbCredentials extends OrbConnectionKey {
  readonly envelope: ConfigValueEnvelope;
}

/**
 * Orb credentials bind the same additional data Orb keys did in
 * `plugin_setting` (plugin `execution`), so a key migration 0084 copied
 * still decrypts, and an envelope can never be replayed in another scope,
 * target, or provider.
 */
const additionalData = (key: OrbConnectionKey) => ({
  kind: "plugin-credential",
  scope: key.scope,
  targetId: key.targetId,
  pluginId: "execution",
  providerId: key.providerId,
});

export const encryptOrbCredentials = (
  keyring: ConfigEncryptionKeyring,
  key: OrbConnectionKey,
  credentials: OrbProviderCredentials,
) =>
  Effect.runPromise(
    encryptConfigValue(
      keyring,
      additionalData(key),
      JSON.stringify(credentials),
    ),
  );

const decodeCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrbProviderCredentials),
);

/**
 * The connection's credentials. An Orb key copied from `plugin_setting` is
 * the bare E2B API key it always held.
 */
export const decryptOrbCredentials = async (
  keyring: ConfigEncryptionKeyring,
  stored: StoredOrbCredentials,
): Promise<OrbProviderCredentials> => {
  const plaintext = await Effect.runPromise(
    decryptConfigValue(keyring, additionalData(stored), stored.envelope),
  );
  const decoded = decodeCredentials(plaintext);
  if (Option.isSome(decoded)) return decoded.value;
  if (stored.providerId === "e2b" && /^\S+$/.test(plaintext))
    return { apiKey: plaintext };
  throw new Error("Orb credentials do not decode.");
};

interface EnvelopeRow {
  readonly scope: OrbConnectionScope;
  readonly target_id: string;
  readonly provider_id: string;
  readonly key_version: number;
  readonly value_nonce: string;
  readonly ciphertext: string;
  readonly wrapped_key_nonce: string;
  readonly wrapped_key: string;
}

export const storedCredentialsFromRow = (
  row: EnvelopeRow,
): StoredOrbCredentials => ({
  scope: row.scope,
  targetId: row.target_id,
  providerId: row.provider_id as ExecutionProviderId,
  envelope: {
    version: 1,
    keyVersion: row.key_version,
    valueNonce: row.value_nonce,
    ciphertext: row.ciphertext,
    wrappedKeyNonce: row.wrapped_key_nonce,
    wrappedKey: row.wrapped_key,
  },
});

/** One connection with its envelope; undefined when there is none. */
export const findConnection = async (
  db: D1Database,
  key: OrbConnectionKey,
): Promise<
  | {
      readonly connection: OrbConnection;
      readonly stored: StoredOrbCredentials;
    }
  | undefined
> => {
  const row = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS}, key_version, value_nonce, ciphertext,
              wrapped_key_nonce, wrapped_key
         FROM orb_connection
        WHERE scope = ? AND target_id = ? AND provider_id = ?`,
    )
    .bind(key.scope, key.targetId, key.providerId)
    .first<OrbConnectionRow & EnvelopeRow>();
  return row === null
    ? undefined
    : {
        connection: connectionFromRow(row),
        stored: storedCredentialsFromRow(row),
      };
};

const progressJson = (preparation: Pick<OrbPreparation, "progress">) =>
  preparation.progress === null ? null : JSON.stringify(preparation.progress);

/**
 * Saves credentials and their first preparation step. Saving again
 * replaces both, so earlier preparation never applies to new credentials.
 */
export const putConnectionStatement = (
  db: D1Database,
  key: OrbConnectionKey,
  input: {
    readonly envelope: ConfigValueEnvelope;
    readonly configuredAt: string;
    readonly recipe: string | null;
    readonly preparation: OrbPreparation;
    /** The version new Threads keep using while this one prepares. */
    readonly served?: OrbServedVersion | null;
  },
) =>
  db
    .prepare(
      `INSERT INTO orb_connection (
         scope, target_id, provider_id, envelope_version, key_version,
         value_nonce, ciphertext, wrapped_key_nonce, wrapped_key,
         configured_at, recipe, account, status, state_json, progress_json,
         error, revision, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (scope, target_id, provider_id) DO UPDATE SET
         envelope_version = 1,
         key_version = excluded.key_version,
         value_nonce = excluded.value_nonce,
         ciphertext = excluded.ciphertext,
         wrapped_key_nonce = excluded.wrapped_key_nonce,
         wrapped_key = excluded.wrapped_key,
         configured_at = excluded.configured_at,
         recipe = excluded.recipe,
         account = excluded.account,
         status = excluded.status,
         state_json = excluded.state_json,
         progress_json = excluded.progress_json,
         error = excluded.error,
         revision = orb_connection.revision + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(
      key.scope,
      key.targetId,
      key.providerId,
      input.envelope.keyVersion,
      input.envelope.valueNonce,
      input.envelope.ciphertext,
      input.envelope.wrappedKeyNonce,
      input.envelope.wrappedKey,
      input.configuredAt,
      input.recipe,
      input.preparation.account,
      input.preparation.status,
      stateJson(input.preparation.state, input.served ?? null),
      progressJson(input.preparation),
      input.preparation.error,
      input.configuredAt,
    );

/**
 * Records one preparation step for the credentials it ran on. False when
 * the connection changed since `expected` was read (saved again, removed,
 * or another step won).
 */
export const recordPreparation = async (
  db: D1Database,
  expected: Pick<
    OrbConnection,
    "scope" | "targetId" | "providerId" | "configuredAt" | "revision"
  >,
  recipe: string,
  preparation: OrbPreparation,
  now: string,
  served: OrbServedVersion | null = null,
) =>
  (
    await db
      .prepare(
        `UPDATE orb_connection SET
           recipe = ?, account = ?, status = ?, state_json = ?,
           progress_json = ?, error = ?, revision = revision + 1,
           updated_at = ?
         WHERE scope = ? AND target_id = ? AND provider_id = ?
           AND configured_at = ? AND revision = ?`,
      )
      .bind(
        recipe,
        preparation.account,
        preparation.status,
        stateJson(preparation.state, served),
        progressJson(preparation),
        preparation.error,
        now,
        expected.scope,
        expected.targetId,
        expected.providerId,
        expected.configuredAt,
        expected.revision,
      )
      .run()
  ).meta.changes === 1;

/**
 * Starts a connection's preparation over at its next step (no recipe), with
 * `served` kept beside its state so new Threads use that version until the
 * new one is ready. Guarded by the connection's revision.
 */
export const restartPreparationRecord = async (
  db: D1Database,
  expected: Pick<
    OrbConnection,
    "scope" | "targetId" | "providerId" | "revision" | "state"
  >,
  served: OrbServedVersion | null,
  now: string,
) =>
  (
    await db
      .prepare(
        `UPDATE orb_connection SET
           recipe = NULL, status = 'preparing', state_json = ?,
           progress_json = NULL, error = NULL, revision = revision + 1,
           updated_at = ?
         WHERE scope = ? AND target_id = ? AND provider_id = ?
           AND revision = ?`,
      )
      .bind(
        stateJson(expected.state, served),
        now,
        expected.scope,
        expected.targetId,
        expected.providerId,
        expected.revision,
      )
      .run()
  ).meta.changes === 1;

export const deleteConnectionStatement = (
  db: D1Database,
  key: OrbConnectionKey,
) =>
  db
    .prepare(
      `DELETE FROM orb_connection
        WHERE scope = ? AND target_id = ? AND provider_id = ?`,
    )
    .bind(key.scope, key.targetId, key.providerId);
