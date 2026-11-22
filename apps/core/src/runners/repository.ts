/**
 * Paired machines and pairing codes (migration 0209). dx stores only the
 * SHA-256 of a runner's token and of a pairing code.
 */

export interface RunnerMachineRow {
  readonly id: string;
  readonly name: string;
  readonly os: "macos" | "linux";
  readonly arch: string;
  readonly version: string;
  readonly created_at: number;
  readonly last_seen_at: number | null;
}

const PAIRING_CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
export const PAIRING_TTL_MS = 15 * 60_000;

export const sha256Hex = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** `BCDF-GHJK`: 20 consonants, eight places, as RFC 8628 suggests. */
export const newPairingCode = () => {
  const values = crypto.getRandomValues(new Uint8Array(8));
  const letters = [...values].map(
    (value) => PAIRING_CODE_LETTERS[value % PAIRING_CODE_LETTERS.length],
  );
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
};

/** A typed code, normalised: case and the dash do not matter. */
export const normalisePairingCode = (code: string) => {
  const letters = code.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8
    ? `${letters.slice(0, 4)}-${letters.slice(4)}`
    : undefined;
};

export const newMachineId = () => `rnm_${randomHex(12)}`;
export const newRunnerToken = () => `dxr_${randomHex(32)}`;

export const listMachines = async (db: D1Database, userId: string) =>
  (
    await db
      .prepare(
        `SELECT id, name, os, arch, version, created_at, last_seen_at
           FROM runner_machine
          WHERE owner_user_id = ? AND revoked_at IS NULL
          ORDER BY last_seen_at IS NULL, last_seen_at DESC, created_at DESC`,
      )
      .bind(userId)
      .all<RunnerMachineRow>()
  ).results;

export const createPairing = async (
  db: D1Database,
  userId: string,
  code: string,
  now = Date.now(),
) => {
  const expiresAt = now + PAIRING_TTL_MS;
  await db.batch([
    // Old codes of the person go: only the newest one pairs.
    db
      .prepare("DELETE FROM runner_pairing WHERE owner_user_id = ?")
      .bind(userId),
    db
      .prepare(
        `INSERT INTO runner_pairing (code_sha256, owner_user_id, expires_at)
         VALUES (?, ?, ?)`,
      )
      .bind(await sha256Hex(code), userId, expiresAt),
  ]);
  return expiresAt;
};

/**
 * Spends a pairing code and records the machine in one batch. Undefined
 * when the code is unknown, used, or expired.
 */
export const pairMachine = async (
  db: D1Database,
  input: {
    readonly code: string;
    readonly name: string;
    readonly os: "macos" | "linux";
    readonly arch: string;
    readonly version: string;
  },
  now = Date.now(),
) => {
  const codeSha = await sha256Hex(input.code);
  const claimed = await db
    .prepare(
      `UPDATE runner_pairing SET used_at = ?, attempts = attempts + 1
        WHERE code_sha256 = ? AND used_at IS NULL AND expires_at > ?
        RETURNING owner_user_id`,
    )
    .bind(now, codeSha, now)
    .first<{ owner_user_id: string }>();
  if (claimed === null) return undefined;
  const machineId = newMachineId();
  const token = newRunnerToken();
  await db
    .prepare(
      `INSERT INTO runner_machine
         (id, owner_user_id, name, os, arch, version, token_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      machineId,
      claimed.owner_user_id,
      input.name,
      input.os,
      input.arch,
      input.version,
      await sha256Hex(token),
      now,
    )
    .run();
  return { machineId, token, ownerUserId: claimed.owner_user_id };
};

/** The live machine a runner token belongs to. */
export const machineForToken = async (db: D1Database, token: string) =>
  (await db
    .prepare(
      `SELECT id, owner_user_id FROM runner_machine
        WHERE token_sha256 = ? AND revoked_at IS NULL`,
    )
    .bind(await sha256Hex(token))
    .first<{ id: string; owner_user_id: string }>()) ?? undefined;

export const revokeMachine = async (
  db: D1Database,
  userId: string,
  machineId: string,
  now = Date.now(),
) =>
  (
    await db
      .prepare(
        `UPDATE runner_machine SET revoked_at = ?
          WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, machineId, userId)
      .run()
  ).meta.changes === 1;

export const recordMachineSeen = async (
  db: D1Database,
  machineId: string,
  seen: {
    readonly at: number;
    readonly version?: string;
    readonly os?: "macos" | "linux";
    readonly arch?: string;
  },
) => {
  await db
    .prepare(
      `UPDATE runner_machine
          SET last_seen_at = ?,
              version = COALESCE(?, version),
              os = COALESCE(?, os),
              arch = COALESCE(?, arch)
        WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(
      seen.at,
      seen.version ?? null,
      seen.os ?? null,
      seen.arch ?? null,
      machineId,
    )
    .run();
};

/** Whether the machine is the person's own and still paired. */
export const ownsMachine = async (
  db: D1Database,
  userId: string,
  machineId: string,
) =>
  (await db
    .prepare(
      `SELECT 1 AS owned FROM runner_machine
        WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(machineId, userId)
    .first()) !== null;

/** The person's most recently seen machine, for a Thread that names none. */
export const defaultMachine = async (db: D1Database, userId: string) =>
  (await listMachines(db, userId))[0]?.id;

/** The machine a runner Thread pinned, with its name. */
export const threadRunner = async (db: D1Database, threadId: string) => {
  const row = await db
    .prepare(
      `SELECT m.id, m.name
         FROM execution_workspace w
         JOIN runner_machine m ON m.id = w.provider_template
        WHERE w.thread_id = ? AND w.provider = 'runner'`,
    )
    .bind(threadId)
    .first<{ id: string; name: string }>();
  return row === null ? undefined : { machineId: row.id, name: row.name };
};

/** Whether a Thread runs on this machine (for its archive upload). */
export const threadPinnedToMachine = async (
  db: D1Database,
  threadId: string,
  machineId: string,
) =>
  (await db
    .prepare(
      `SELECT 1 AS pinned FROM execution_workspace
        WHERE thread_id = ? AND provider = 'runner' AND provider_template = ?`,
    )
    .bind(threadId, machineId)
    .first()) !== null;
