-- The plan limit a waiting Thread failed on, as `claudePlanLimitText` writes
-- it, so a Space can show its own limit card. NULL for waits recorded
-- before this column.
ALTER TABLE thread_plan_wait ADD COLUMN limit_text TEXT;
