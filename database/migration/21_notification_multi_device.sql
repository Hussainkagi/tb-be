-- Migration: allow multiple device tokens per employee per notification
-- Drops the old unique constraint on (notification_id, employee_id, channel)
-- and replaces it with a unique constraint that includes device_token so
-- a single notification can have multiple recipient rows for different
-- device tokens belonging to the same employee.

BEGIN;

ALTER TABLE notification_recipients
    DROP CONSTRAINT IF EXISTS uq_notif_recipient_channel;

ALTER TABLE notification_recipients
    ADD CONSTRAINT uq_notif_recipient_channel_device
        UNIQUE (notification_id, employee_id, channel, device_token);

COMMIT;
