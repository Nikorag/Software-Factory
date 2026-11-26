-- Web Push delivery. A delivery is one notification for one browser subscription. The rendered payload is stored on
-- the row (so a test notification and an event notification are sent the same way, and the sender needs no joins),
-- and next_attempt_at drives retry backoff. Additive only: existing rows keep working.
ALTER TABLE notification_deliveries
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (next_attempt_at) WHERE status = 'pending';
