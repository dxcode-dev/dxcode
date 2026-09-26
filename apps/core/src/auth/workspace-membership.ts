export const workspaceMembershipExists = async (
  db: D1Database,
  userId: string,
): Promise<boolean> =>
  (await db
    .prepare("SELECT id FROM member WHERE userId = ?")
    .bind(userId)
    .first()) !== null;
