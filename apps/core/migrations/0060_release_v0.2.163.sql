-- Whether dx read the linked issue or PR with the Thread owner's GitHub
-- credentials when it linked it. Webhooks, other Threads' reads, and merge
-- shipping write only verified links, and only a verified link's title and
-- state are shown: an unverified one names an item its owner may not see.
-- Every link written from now on is verified (link_github_issue and comment
-- subscriptions both read GitHub first).
--
-- Older links from link_github_issue may have been saved without
-- credentials, and nothing records which, so they start unverified; linking
-- one again verifies it. A comment subscription checked the repository with
-- the owner's credentials when it was created, so its links are verified.
-- Nothing is deleted: dropping this column restores the old rows as they
-- were.
ALTER TABLE thread_github_link
  ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1));

UPDATE thread_github_link
   SET verified = 1
 WHERE EXISTS (
   SELECT 1 FROM github_subscription AS subscription
    WHERE subscription.thread_id = thread_github_link.thread_id
      AND subscription.destination = 'this-thread'
      AND subscription.filter_kind IN ('pr-comments', 'issue-comments')
      AND lower(subscription.repository) = thread_github_link.repository_key
      AND CAST(json_extract(subscription.filter_json,
            CASE subscription.filter_kind WHEN 'pr-comments' THEN '$.prNumber'
                                          ELSE '$.issueNumber' END) AS INTEGER)
          = thread_github_link.number
 );
