-- Thread View: how a Thread's transcript shows a turn. Detailed shows every
-- step; Simple shows only what the agent shows. It syncs with the account's
-- other appearance values. Accounts created from here on start on Simple
-- (the column default, which the user insert trigger takes); accounts that
-- already exist keep Detailed, the view they know.
ALTER TABLE personal_account
  ADD COLUMN thread_view TEXT NOT NULL DEFAULT 'simple'
  CHECK (thread_view IN ('detailed', 'simple'));

UPDATE personal_account SET thread_view = 'detailed';
