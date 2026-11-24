-- Fixed-window request budgets (apps/core/src/security/request-budget.ts):
-- runner pairing guesses (#2436) and Portal feedback sends (#2437). One row
-- per key; its count restarts when a new window starts. Runner pairing codes
-- never had the "five wrong guesses" 0212 describes: a wrong code matches no
-- row, so guessing is bounded per address and overall here instead.
CREATE TABLE IF NOT EXISTS request_budget (
  key TEXT NOT NULL PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS request_budget_window_idx
  ON request_budget (window_started_at);
