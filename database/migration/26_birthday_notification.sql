-- ============================================================
-- 26_birthday_notification.sql
-- Must run after 19_notification.sql
--
-- Adds employee birthday notifications:
--   • birthday_wish        → to the birthday employee ("Happy Birthday!")
--   • birthday_announcement → to their branch colleagues
--
-- Also adds `exclude_employee_id` to audience rules, so an 'all_branch'
-- announcement can skip the person it is about. Without it the birthday
-- employee would receive both the wish AND the announcement about
-- themselves. Using 'all_branch' + exclusion (rather than listing every
-- colleague as a specific_employee) keeps this working for branches of
-- any size — the specific_employees path caps out at 500.
-- ============================================================

-- ------------------------------------------------------------
-- 1. AUDIENCE RULES — optional exclusion
-- ------------------------------------------------------------

ALTER TABLE notification_audience_rules
    ADD COLUMN IF NOT EXISTS exclude_employee_id UUID
        REFERENCES employees(id) ON DELETE CASCADE;


-- ------------------------------------------------------------
-- 2. Allow the two new notification_type values
--    (three separate CHECK constraints reference this list)
-- ------------------------------------------------------------

ALTER TABLE notification_templates
    DROP CONSTRAINT IF EXISTS chk_template_notification_type;
ALTER TABLE notification_templates
    ADD CONSTRAINT chk_template_notification_type
    CHECK (notification_type IN (
        'leave_request',
        'leave_status_update',
        'holiday_created',
        'holiday_request',
        'attendance_checkin_reminder',
        'attendance_checkout_reminder',
        'birthday_wish',
        'birthday_announcement',
        'custom',
        'system'
    ));

ALTER TABLE notifications
    DROP CONSTRAINT IF EXISTS chk_notif_type;
ALTER TABLE notifications
    ADD CONSTRAINT chk_notif_type
    CHECK (notification_type IN (
        'leave_request',
        'leave_status_update',
        'holiday_created',
        'holiday_request',
        'attendance_checkin_reminder',
        'attendance_checkout_reminder',
        'birthday_wish',
        'birthday_announcement',
        'custom',
        'system'
    ));

ALTER TABLE notification_preferences
    DROP CONSTRAINT IF EXISTS chk_pref_notification_type;
ALTER TABLE notification_preferences
    ADD CONSTRAINT chk_pref_notification_type
    CHECK (notification_type IN (
        'leave_request',
        'leave_status_update',
        'holiday_created',
        'holiday_request',
        'attendance_checkin_reminder',
        'attendance_checkout_reminder',
        'birthday_wish',
        'birthday_announcement',
        'custom',
        'system'
    ));


-- ------------------------------------------------------------
-- 3. Idempotency — one wish + one announcement per employee per day
--    Mirrors uq_attendance_reminder_once_per_day: the job can run
--    repeatedly (hourly, restarts, multiple instances) and the second
--    attempt hits a unique violation that the service treats as
--    "already scheduled" instead of sending a duplicate.
-- ------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_birthday_notification_once_per_day
    ON notifications (notification_type, entity_id, (scheduled_at::date))
    WHERE entity_type = 'employee_birthday'
      AND deleted_at IS NULL;


-- ------------------------------------------------------------
-- 4. SEED: global birthday templates (company_id = NULL)
--    company_id is NULL here, and NULL <> NULL in a UNIQUE constraint,
--    so ON CONFLICT cannot dedupe these — guard with NOT EXISTS instead
--    to keep this migration safe to re-run.
-- ------------------------------------------------------------

INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
)
SELECT v.company_id, v.template_code, v.notification_type, v.channel,
       v.title_template, v.body_template, v.deep_link_template
FROM (VALUES
    -- ── To the birthday employee ──────────────────────────────────────────
    (NULL::uuid, 'birthday_wish', 'birthday_wish', 'push',
     '🎂 Happy Birthday, {{employee_first_name}}!',
     'Wishing you a wonderful year ahead from everyone at {{company_name}}. 🎉',
     '/profile'),

    (NULL::uuid, 'birthday_wish', 'birthday_wish', 'in_app',
     '🎂 Happy Birthday, {{employee_first_name}}!',
     'The whole team at {{company_name}} wishes you a fantastic birthday and a brilliant year ahead. 🎉',
     '/profile'),

    -- ── To their branch colleagues ────────────────────────────────────────
    (NULL::uuid, 'birthday_announcement', 'birthday_announcement', 'push',
     '🎉 It''s {{employee_name}}''s birthday!',
     '{{employee_name}} from {{branch_name}} is celebrating today. Drop by and wish them well!',
     '/employees/{{employee_id}}'),

    (NULL::uuid, 'birthday_announcement', 'birthday_announcement', 'in_app',
     '🎉 Birthday today: {{employee_name}}',
     '{{employee_name}}{{job_title_suffix}} at {{branch_name}} is celebrating their birthday today. Take a moment to wish them a happy birthday!',
     '/employees/{{employee_id}}')
) AS v(company_id, template_code, notification_type, channel,
       title_template, body_template, deep_link_template)
WHERE NOT EXISTS (
    SELECT 1 FROM notification_templates t
    WHERE t.company_id IS NULL
      AND t.template_code = v.template_code
      AND t.channel = v.channel
);
