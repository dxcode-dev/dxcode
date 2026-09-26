const normalizedEmail = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : undefined;

export const waitlistAdmission = (db: D1Database) => async (input: string) => {
  const email = normalizedEmail(input);
  if (email === undefined) return false;
  const access = await db
    .prepare("SELECT status FROM auth_waitlist WHERE email = ?")
    .bind(email)
    .first<{ readonly status: string }>();
  if (access?.status === "approved") return true;
  if (access === null) {
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO auth_waitlist (email, status, created_at, updated_at)
         VALUES (?, 'pending', ?, ?)
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(email, now, now)
      .run();
  }
  return false;
};
