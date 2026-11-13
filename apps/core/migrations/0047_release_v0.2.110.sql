-- Huddle links: a short, typeable code for a shared Thread's or Space's
-- huddle, opened at /huddle/<workspace>/<code>. Nine letters from an
-- alphabet without i, l, or o, stored lowercase without hyphens and shown
-- as abc-def-ghk. One code per Thread, kept once made, so every copy of the
-- link is the same. Deleting the Thread deletes its code.
CREATE TABLE huddle_links (
  code TEXT PRIMARY KEY
    CHECK (length(code) = 9 AND code NOT GLOB '*[^abcdefghjkmnpqrstuvwxyz]*'),
  thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
