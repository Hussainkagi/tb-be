-- ============================================================
-- 56_attendance_requests.sql
-- Must run after 55_branch_locations.sql (and 41_task_notifications.sql for
-- the notification type lists repeated below)
--
-- Attendance from somewhere other than the branch or its sites (working
-- from home, an unplanned client visit). The employee sends a request with
-- their position instead of checking in; an admin approves it, in bulk if
-- they like, as a full day or as a half day, or rejects it. Approval writes
-- the attendance row exactly as a check-in / check-out would have.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Half day, decided by an admin
--
-- Until now a half day was only ever derived from hours worked against the
-- shift's half_day_hours. An admin approving a remote day "as a half day"
-- needs to say so explicitly, and payroll, the calendar and the reports
-- must all honour it.
-- ------------------------------------------------------------
ALTER TABLE attendance
    ADD COLUMN IF NOT EXISTS is_half_day BOOLEAN NOT NULL DEFAULT FALSE;

-- ------------------------------------------------------------
-- 2. Requests
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_requests (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id           UUID            REFERENCES branches(id) ON DELETE SET NULL,
    employee_id         UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    request_type        VARCHAR(20)     NOT NULL CHECK (request_type IN ('check-in', 'check-out')),
    attendance_date     DATE            NOT NULL,           -- in the shift's timezone
    requested_at        TIMESTAMP       NOT NULL,           -- the moment it would have been recorded
    latitude            DECIMAL(10,8),
    longitude           DECIMAL(11,8),
    address             TEXT,
    selfie              TEXT,
    selfie_url          TEXT,
    reason              TEXT,

    status              VARCHAR(20)     NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    approved_as_half_day BOOLEAN        NOT NULL DEFAULT FALSE,
    reviewed_by         UUID            REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at         TIMESTAMP,
    review_note         TEXT,
    attendance_id       UUID            REFERENCES attendance(id) ON DELETE SET NULL,

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The admin queue: a company's requests by status, newest first.
CREATE INDEX IF NOT EXISTS idx_attendance_requests_company_status
    ON attendance_requests(company_id, status, requested_at DESC);

-- The employee's own requests for a day.
CREATE INDEX IF NOT EXISTS idx_attendance_requests_employee_date
    ON attendance_requests(employee_id, attendance_date);

-- At most one open request per employee, day and direction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_requests_pending
    ON attendance_requests(employee_id, attendance_date, request_type)
    WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_attendance_requests_updated_at ON attendance_requests;
CREATE TRIGGER trg_attendance_requests_updated_at
    BEFORE UPDATE ON attendance_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 3. Notification types. Each CHECK is replaced whole, repeating every
--    type from 41_task_notifications.sql.
--      attendance_request         — admins: someone asked to be marked present
--      attendance_request_status  — employee: their request was decided
-- ------------------------------------------------------------
ALTER TABLE notification_templates DROP CONSTRAINT IF EXISTS chk_template_notification_type;
ALTER TABLE notification_templates
    ADD CONSTRAINT chk_template_notification_type CHECK (
        notification_type IN (
            'leave_request', 'leave_status_update', 'holiday_created', 'holiday_request',
            'attendance_checkin_reminder', 'attendance_checkout_reminder',
            'birthday_wish', 'birthday_announcement', 'payslip_published',
            'task_assigned', 'task_due_reminder', 'task_overdue', 'task_status_update',
            'attendance_request', 'attendance_request_status',
            'custom', 'system'
        )
    );

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS chk_notif_type;
ALTER TABLE notifications
    ADD CONSTRAINT chk_notif_type CHECK (
        notification_type IN (
            'leave_request', 'leave_status_update', 'holiday_created', 'holiday_request',
            'attendance_checkin_reminder', 'attendance_checkout_reminder',
            'birthday_wish', 'birthday_announcement', 'payslip_published',
            'task_assigned', 'task_due_reminder', 'task_overdue', 'task_status_update',
            'attendance_request', 'attendance_request_status',
            'custom', 'system'
        )
    );

ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS chk_pref_notification_type;
ALTER TABLE notification_preferences
    ADD CONSTRAINT chk_pref_notification_type CHECK (
        notification_type IN (
            'leave_request', 'leave_status_update', 'holiday_created', 'holiday_request',
            'attendance_checkin_reminder', 'attendance_checkout_reminder',
            'birthday_wish', 'birthday_announcement', 'payslip_published',
            'task_assigned', 'task_due_reminder', 'task_overdue', 'task_status_update',
            'attendance_request', 'attendance_request_status',
            'custom', 'system'
        )
    );

-- ------------------------------------------------------------
-- 4. Templates. Admin events go out on in_app (the admin inbox) and push;
--    the employee's result on push and in_app.
-- ------------------------------------------------------------
INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
) VALUES

(NULL, 'attendance_request_submitted', 'attendance_request', 'in_app',
 'Attendance request — {{employee_name}}',
 '{{employee_name}} ({{employee_code}}) asked to {{request_label}} from outside the office on {{attendance_date}} at {{request_time}}.',
 '/attendance-requests'),

(NULL, 'attendance_request_submitted', 'attendance_request', 'push',
 '📍 Attendance request — {{employee_name}}',
 '{{employee_name}} asked to {{request_label}} from outside the office. Tap to review.',
 '/attendance-requests'),

(NULL, 'attendance_request_approved', 'attendance_request_status', 'push',
 '✅ Attendance approved',
 'Your {{request_label}} for {{attendance_date}} was approved{{half_day_clause}}.',
 NULL),

(NULL, 'attendance_request_approved', 'attendance_request_status', 'in_app',
 'Attendance approved',
 'Your {{request_label}} for {{attendance_date}} was approved{{half_day_clause}}.',
 NULL),

(NULL, 'attendance_request_rejected', 'attendance_request_status', 'push',
 '❌ Attendance request rejected',
 'Your {{request_label}} for {{attendance_date}} was not approved. {{review_note}}',
 NULL),

(NULL, 'attendance_request_rejected', 'attendance_request_status', 'in_app',
 'Attendance request rejected',
 'Your {{request_label}} for {{attendance_date}} was not approved. {{review_note}}',
 NULL)

ON CONFLICT (company_id, template_code, channel) DO NOTHING;
