-- Archiving a Thread used to end each GitHub subscription of it at its next
-- event ("Its Thread was archived."), so restoring the Thread did not bring
-- them back. An archived Thread's subscriptions now stay active and let
-- events pass until it is restored: those it ended listen again, unless
-- they had expired by now.
UPDATE github_subscription
   SET state = 'active', state_detail = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE state = 'failed' AND state_detail = 'Its Thread was archived.'
   AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
