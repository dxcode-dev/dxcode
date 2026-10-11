/**
 * Fills a name the user never set from a provider that knows it, such as
 * Google linking to an account a magic link created without one. Names the
 * user already has, or edited, stay as they are.
 */
export const fillMissingName = async (
  db: D1Database,
  userId: string,
  providerName: unknown,
) => {
  const name =
    typeof providerName === "string"
      ? providerName.trim().slice(0, 128).trim()
      : "";
  if (name.length === 0) return;
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE "user" SET name = ?, updatedAt = ? WHERE id = ? AND trim(name) = ''`,
      )
      .bind(name, now, userId),
    // 'User' is the placeholder migration 0004 gives a nameless user.
    db
      .prepare(
        "UPDATE personal_account SET display_name = ?, updated_at = ? WHERE user_id = ? AND display_name = 'User'",
      )
      .bind(name, now, userId),
  ]);
};
