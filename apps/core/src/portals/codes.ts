// One-time Portal sign-in codes in D1 (migration 0076). A code is minted on
// the dx app origin after authorization and redeemed once on the Portal host.

import { sha256Hex } from "./crypto.js";

export const PORTAL_CODE_TTL_MS = 60_000;

export interface PortalCodeGrant {
  readonly portalHost: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly email?: string;
  readonly name?: string;
  readonly returnPath: string;
}

export const storePortalCode = async (
  db: D1Database,
  code: string,
  state: string,
  grant: PortalCodeGrant,
  nowMs: number,
) => {
  const [codeHash, stateHash] = await Promise.all([
    sha256Hex(code),
    sha256Hex(state),
  ]);
  await db.batch([
    // Expired codes are useless; each handshake sweeps a bounded batch.
    db
      .prepare(
        "DELETE FROM portal_auth_codes WHERE code_hash IN (SELECT code_hash FROM portal_auth_codes WHERE expires_at < ? LIMIT 100)",
      )
      .bind(nowMs),
    db
      .prepare(
        `INSERT INTO portal_auth_codes
           (code_hash, state_hash, portal_host, user_id, session_id, user_email,
            user_name, return_path, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        codeHash,
        stateHash,
        grant.portalHost,
        grant.userId,
        grant.sessionId,
        grant.email ?? null,
        grant.name ?? null,
        grant.returnPath,
        nowMs + PORTAL_CODE_TTL_MS,
        nowMs,
      ),
  ]);
};

interface PortalCodeRow {
  readonly state_hash: string;
  readonly portal_host: string;
  readonly user_id: string;
  readonly session_id: string;
  readonly user_email: string | null;
  readonly user_name: string | null;
  readonly return_path: string;
  readonly expires_at: number;
}

/**
 * Consumes a code. The row is deleted whatever happens next, so a code
 * presented twice, late, with another state, or on another host fails.
 */
export const redeemPortalCode = async (
  db: D1Database,
  code: string,
  state: string,
  portalHost: string,
  nowMs: number,
): Promise<PortalCodeGrant | undefined> => {
  const [codeHash, stateHash] = await Promise.all([
    sha256Hex(code),
    sha256Hex(state),
  ]);
  const row = await db
    .prepare(
      `DELETE FROM portal_auth_codes WHERE code_hash = ?
       RETURNING state_hash, portal_host, user_id, session_id, user_email,
                 user_name, return_path, expires_at`,
    )
    .bind(codeHash)
    .first<PortalCodeRow>();
  if (
    row === null ||
    row.expires_at <= nowMs ||
    row.state_hash !== stateHash ||
    row.portal_host !== portalHost
  )
    return undefined;
  return {
    portalHost: row.portal_host,
    userId: row.user_id,
    sessionId: row.session_id,
    ...(row.user_email === null ? {} : { email: row.user_email }),
    ...(row.user_name === null ? {} : { name: row.user_name }),
    returnPath: row.return_path,
  };
};
