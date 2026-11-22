const normalizedEmail = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : undefined;

/**
 * `approved` admits the address; `joined` means this request added it to
 * the waitlist, so it is the one time to tell the person; `waiting` is an
 * address already pending or rejected.
 */
export type WaitlistAdmission = "approved" | "joined" | "waiting";

export const waitlistAdmission =
  (db: D1Database) =>
  async (input: string): Promise<WaitlistAdmission> => {
    const email = normalizedEmail(input);
    if (email === undefined) return "waiting";
    const access = await db
      .prepare("SELECT status FROM auth_waitlist WHERE email = ?")
      .bind(email)
      .first<{ readonly status: string }>();
    if (access?.status === "approved") return "approved";
    if (access !== null) return "waiting";
    const now = new Date().toISOString();
    // Two requests racing for the same new address both reach here; only
    // the one whose insert lands reports `joined`.
    const inserted = await db
      .prepare(
        `INSERT INTO auth_waitlist (email, status, created_at, updated_at)
         VALUES (?, 'pending', ?, ?)
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(email, now, now)
      .run();
    return inserted.meta.changes === 1 ? "joined" : "waiting";
  };

/** An operator approval, such as the deployment's first administrator. */
export const waitlistApproved = async (db: D1Database, input: string) => {
  const email = normalizedEmail(input);
  if (email === undefined) return false;
  return (
    (await db
      .prepare("SELECT status FROM auth_waitlist WHERE email = ?")
      .bind(email)
      .first("status")) === "approved"
  );
};
