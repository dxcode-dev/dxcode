-- The panes and tabs a person has open on one Thread, the same on every
-- device they sign in on. `layout` is the JSON the web app's pane layout
-- schema accepts (`ThreadPaneLayoutSchema` in @dx/api); a row the current
-- schema no longer accepts falls back to the default layout. Deleting a
-- Thread removes its rows.
CREATE TABLE thread_pane_layout (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  layout TEXT NOT NULL CHECK (length(layout) BETWEEN 2 AND 32768),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;
