import type { OnboardingData, OnboardingMilestone } from "@dx/api";
import type { UserId } from "@dx/domain";

const text = (value: unknown) => (typeof value === "string" ? value : null);

/** The person's onboarding progress; all null without a row (a new account). */
export const readOnboarding = async (
  db: D1Database,
  userId: UserId,
): Promise<OnboardingData> => {
  const row = await db
    .prepare(
      `SELECT setup_finished_at, tour_finished_at, checklist_hidden_at
         FROM user_onboarding WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<Record<string, unknown>>();
  return {
    setupFinishedAt: text(row?.setup_finished_at),
    tourFinishedAt: text(row?.tour_finished_at),
    checklistHiddenAt: text(row?.checklist_hidden_at),
  };
};

const COLUMN: Record<OnboardingMilestone, string> = {
  setup: "setup_finished_at",
  tour: "tour_finished_at",
  checklist: "checklist_hidden_at",
};

/** Marks one milestone done. A milestone already done keeps its first time. */
export const markOnboarding = async (
  db: D1Database,
  userId: UserId,
  milestone: OnboardingMilestone,
  now = new Date(),
) => {
  const column = COLUMN[milestone];
  await db
    .prepare(
      `INSERT INTO user_onboarding (user_id, ${column}, updated_at)
       VALUES (?1, ?2, ?2)
       ON CONFLICT (user_id) DO UPDATE SET
         ${column} = COALESCE(user_onboarding.${column}, excluded.${column}),
         updated_at = excluded.updated_at`,
    )
    .bind(userId, now.toISOString())
    .run();
};
