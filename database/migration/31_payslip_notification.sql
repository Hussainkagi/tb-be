-- ============================================================
-- 31_payslip_notification.sql
-- Must run after 19_notification.sql and 30_payroll_run.sql
--
-- Lets a paid payroll notify employees on their phones.
--
-- 'payslip_published' has to be added to three separate CHECK
-- constraints — templates, notifications and preferences each
-- carry their own copy of the type list. Miss one and the send
-- fails at the last step with a constraint violation.
--
-- Each list must also REPEAT every type added by earlier migrations
-- (26_birthday_notification.sql added birthday_wish and
-- birthday_announcement). A CHECK is replaced wholesale, not
-- appended to, so an omission here would be rejected outright by
-- the rows already in notification_templates.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Allow the new notification type everywhere it is validated
-- ------------------------------------------------------------
ALTER TABLE notification_templates DROP CONSTRAINT IF EXISTS chk_template_notification_type;
ALTER TABLE notification_templates
    ADD CONSTRAINT chk_template_notification_type CHECK (
        notification_type IN (
            'leave_request',
            'leave_status_update',
            'holiday_created',
            'holiday_request',
            'attendance_checkin_reminder',
            'attendance_checkout_reminder',
            'birthday_wish',
            'birthday_announcement',
            'payslip_published',
            'custom',
            'system'
        )
    );

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notif_type;
ALTER TABLE notifications
    ADD CONSTRAINT chk_notif_type CHECK (
        notification_type IN (
            'leave_request',
            'leave_status_update',
            'holiday_created',
            'holiday_request',
            'attendance_checkin_reminder',
            'attendance_checkout_reminder',
            'birthday_wish',
            'birthday_announcement',
            'payslip_published',
            'custom',
            'system'
        )
    );

ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS chk_pref_notification_type;
ALTER TABLE notification_preferences
    ADD CONSTRAINT chk_pref_notification_type CHECK (
        notification_type IN (
            'leave_request',
            'leave_status_update',
            'holiday_created',
            'holiday_request',
            'attendance_checkin_reminder',
            'attendance_checkout_reminder',
            'birthday_wish',
            'birthday_announcement',
            'payslip_published',
            'custom',
            'system'
        )
    );


-- ------------------------------------------------------------
-- 2. Templates
--
-- push  → the phone alert
-- in_app → the persisted inbox row. Always seed both: fan-out
--          only writes a recipient row for `push` when the
--          employee has an ACTIVE device token, so a push-only
--          notification vanishes for anyone without the app
--          installed (same trap documented in 29_admin_inbox.sql).
-- ------------------------------------------------------------
INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
) VALUES

(NULL, 'payslip_published', 'payslip_published', 'push',
 '💰 Payslip Available — {{period_name}}',
 'Your salary for {{period_name}} has been paid. Net {{currency}} {{net_salary}}. Tap to view your payslip.',
 '/payslips/{{payslip_id}}'),

(NULL, 'payslip_published', 'payslip_published', 'in_app',
 'Payslip for {{period_name}}',
 'Your salary for {{period_name}} has been processed and paid. Net pay: {{currency}} {{net_salary}} (payslip {{payslip_number}}).',
 '/payslips/{{payslip_id}}')

ON CONFLICT (company_id, template_code, channel) DO NOTHING;


-- ------------------------------------------------------------
-- 3. Track in-app/push delivery on the payslip itself, the same
--    way email delivery is tracked — so "notify" is retryable
--    and the run can report what actually reached people.
-- ------------------------------------------------------------
ALTER TABLE payslips
    ADD COLUMN IF NOT EXISTS notification_status VARCHAR(20) NOT NULL DEFAULT 'pending'
                                CHECK (notification_status IN ('pending', 'sent', 'failed', 'skipped')),
    ADD COLUMN IF NOT EXISTS notified_at        TIMESTAMP,
    ADD COLUMN IF NOT EXISTS notification_error TEXT;

CREATE INDEX IF NOT EXISTS idx_payslips_notification_status
    ON payslips(payroll_run_id, notification_status);
