-- A person's sidebar layout, shared by every device they sign in on. A row
-- records one choice: a parent Thread whose children are shown (`thread`;
-- only open parents are kept, closed is the default), or a Project, Inactive,
-- or Archived section opened or closed (`section`). Without a row the
-- sidebar's default applies. Rows past the newest 500 per person are pruned.
CREATE TABLE sidebar_layout_entry (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'section')),
  item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 128),
  open INTEGER NOT NULL CHECK (open IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, item_id)
) WITHOUT ROWID;
