-- ============================================================
-- 41_task_notifications.sql
-- Must run after 19_notification.sql, 31_payslip_notification.sql
--                and 40_task_module.sql
--
-- Same three-CHECK dance as 31_payslip_notification.sql: templates,
-- notifications and preferences each carry their own copy of the type list,
-- a CHECK is replaced wholesale rather than appended to, and every type
-- added by an earlier migration has to be repeated verbatim or the ALTER is
-- rejected by rows that already exist.
--
-- Types added here:
--   task_assigned        — you have been given a task
--   task_due_reminder    — one day before the deadline, in the company's zone
--   task_overdue         — the deadline passed and the task is still open
--   task_status_update   — someone moved your task / a task you watch
-- ============================================================

-- ------------------------------------------------------------
-- 1. Allow the new notification types everywhere they are validated
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
            'task_assigned',
            'task_due_reminder',
            'task_overdue',
            'task_status_update',
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
            'task_assigned',
            'task_due_reminder',
            'task_overdue',
            'task_status_update',
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
            'task_assigned',
            'task_due_reminder',
            'task_overdue',
            'task_status_update',
            'custom',
            'system'
        )
    );


-- ------------------------------------------------------------
-- 2. Templates — push AND in_app for every event
--
-- push  → the phone alert
-- in_app → the durable inbox row. Fan-out only writes a recipient row for
--          `push` when the employee has an ACTIVE device token, so a
--          push-only event vanishes for a manager who lives in the web
--          panel (the trap documented in 29_admin_inbox.sql / 31).
-- ------------------------------------------------------------
INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
) VALUES

-- ── Assigned ────────────────────────────────────────────────────────────
(NULL, 'task_assigned', 'task_assigned', 'push',
 '📋 New Task — {{priority_label}}',
 '{{assigned_by_name}} assigned you "{{task_title}}"{{due_clause}}. Tap to open it.',
 '/tasks/{{task_id}}'),

(NULL, 'task_assigned', 'task_assigned', 'in_app',
 'New task: {{task_title}}',
 '{{assigned_by_name}} assigned you "{{task_title}}" ({{category_name}}, {{priority_label}} priority){{due_clause}}.',
 '/tasks/{{task_id}}'),

-- ── Reassigned (same event, different wording) ──────────────────────────
(NULL, 'task_reassigned', 'task_assigned', 'push',
 '📋 Task Reassigned to You',
 '{{assigned_by_name}} moved "{{task_title}}" to you{{due_clause}}.',
 '/tasks/{{task_id}}'),

(NULL, 'task_reassigned', 'task_assigned', 'in_app',
 'Task reassigned: {{task_title}}',
 '{{assigned_by_name}} reassigned "{{task_title}}" ({{priority_label}} priority) to you{{due_clause}}.',
 '/tasks/{{task_id}}'),

-- ── Deadline tomorrow ───────────────────────────────────────────────────
(NULL, 'task_due_reminder', 'task_due_reminder', 'push',
 '⏰ Due Tomorrow — {{task_title}}',
 '"{{task_title}}" is due {{due_display}}. It is still marked {{status_label}}.',
 '/tasks/{{task_id}}'),

(NULL, 'task_due_reminder', 'task_due_reminder', 'in_app',
 'Task due tomorrow: {{task_title}}',
 '"{{task_title}}" ({{priority_label}} priority) is due {{due_display}} and is still {{status_label}}.',
 '/tasks/{{task_id}}'),

-- ── Overdue ─────────────────────────────────────────────────────────────
(NULL, 'task_overdue', 'task_overdue', 'push',
 '🔴 Overdue — {{task_title}}',
 '"{{task_title}}" was due {{due_display}} and is still {{status_label}}.',
 '/tasks/{{task_id}}'),

(NULL, 'task_overdue', 'task_overdue', 'in_app',
 'Task overdue: {{task_title}}',
 '"{{task_title}}" ({{priority_label}} priority) was due {{due_display}} and has not been completed.',
 '/tasks/{{task_id}}'),

-- ── Status moved ────────────────────────────────────────────────────────
(NULL, 'task_status_update', 'task_status_update', 'push',
 'Task {{status_label}} — {{task_title}}',
 '{{actor_name}} moved "{{task_title}}" to {{status_label}}.',
 '/tasks/{{task_id}}'),

(NULL, 'task_status_update', 'task_status_update', 'in_app',
 '{{task_title}} → {{status_label}}',
 '{{actor_name}} moved "{{task_title}}" from {{previous_status_label}} to {{status_label}}. {{remark_clause}}',
 '/tasks/{{task_id}}')

ON CONFLICT (company_id, template_code, channel) DO NOTHING;


-- ------------------------------------------------------------
-- 3. Idempotency for the deadline sweep
--
-- taskDeadlineJob runs hourly (every company's local morning falls inside
-- some hour), so each task is evaluated ~24 times per day. Without this
-- index a restart or a second instance sends the same "due tomorrow" push
-- again and again — the exact failure 22_attendance_reminder_dedup.sql was
-- written for.
--
-- One reminder of each kind per task per scheduled day. entity_id is the
-- task id; send() catches the resulting 23505 and reports `skipped`.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_reminder_once_per_day
    ON notifications (notification_type, channel, entity_id, (scheduled_at::date))
    WHERE entity_type = 'tasks'
      AND notification_type IN ('task_due_reminder', 'task_overdue')
      AND deleted_at IS NULL;
