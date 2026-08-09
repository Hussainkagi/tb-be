-- ============================================================
-- 29_admin_inbox.sql
-- Must run after 19_notification.sql
--
-- Supports the company-admin inbox (/notifications/admin/inbox).
--
-- Why an in_app copy is needed at all:
--   The fan-out worker only writes a notification_recipients row for a
--   `push` notification when the employee has an ACTIVE device token
--   (see notificationService fan-out — "no token → skip silently").
--   Company admins work in the web panel and usually have no mobile
--   device registered, so every admin-facing alert was created, fanned
--   out to zero rows, and vanished.
--
--   Admin-facing events now dispatch on `in_app` as well, which always
--   persists a recipient row. That row is what the admin inbox reads.
--   The seed in 19_notification.sql shipped an in_app template for
--   leave_request_submitted but not for holiday_request_submitted —
--   without it the in_app send fails template resolution.
-- ============================================================

INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
) VALUES

(NULL, 'holiday_request_submitted', 'holiday_request', 'in_app',
 'Holiday Request — {{employee_name}}',
 '{{employee_name}} has requested {{holiday_date}} as a holiday. Tap to review.',
 '/admin/holiday-requests/{{request_id}}')

ON CONFLICT (company_id, template_code, channel) DO NOTHING;


-- ------------------------------------------------------------
-- Index: the admin inbox groups a company's recipient rows by
-- notification (one admin, many notifications, possibly several
-- device rows each) and orders by arrival.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_notif_recipients_employee_notification
    ON notification_recipients(employee_id, company_id, notification_id)
    WHERE status <> 'cancelled';
