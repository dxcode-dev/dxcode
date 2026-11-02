-- Needs-you Prioritize (#1447): each person's last ranking of what waits on
-- them, replaced by the next one. `ranking_json` holds the ranked asks as
-- they were when ranked; only the person's own routes read or write it.
CREATE TABLE needs_you_ranking (
  user_id TEXT PRIMARY KEY,
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  ranking_json TEXT NOT NULL CHECK (length(ranking_json) <= 400000),
  ranked_at TEXT NOT NULL
);
