-- ============================================================
-- 19_notification.sql
-- Must run after:
--   01_company.sql, 02_branch.sql, 07_shift.sql,
--   08_employee.sql, 04_user_company.sql
--
-- Tables:
--   1. notification_templates       — reusable message skeletons
--   2. notifications                — one row per notification event/intent
--   3. notification_audience_rules  — who receives it (resolved before fan-out)
--   4. notification_recipients      — per-employee per-channel delivery log
--   5. employee_device_tokens       — FCM / APNs push tokens per device
--   6. notification_preferences     — per-employee opt-in/out per type+channel
-- ============================================================


-- ============================================================
-- 1. notification_templates
--    Reusable message skeletons with {{mustache}} placeholders.
--    company_id = NULL  → global system template
--    company_id = set   → company override of a system template
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_templates (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id          UUID            REFERENCES companies(id) ON DELETE CASCADE,
    -- NULL = global template; companies can override per template_code + channel

    -- Identity
    template_code       VARCHAR(100)    NOT NULL,
    -- e.g. 'leave_request_submitted' | 'attendance_checkin_reminder'

    notification_type   VARCHAR(50)     NOT NULL,
    -- leave_request | leave_status_update | holiday_created | holiday_request
    -- attendance_checkin_reminder | attendance_checkout_reminder | custom | system

    channel             VARCHAR(20)     NOT NULL DEFAULT 'push',
    -- push | in_app | email | sms

    -- Content (supports {{variable}} placeholders)
    title_template      VARCHAR(255)    NOT NULL,
    body_template       TEXT            NOT NULL,
    deep_link_template  VARCHAR(500),
    -- e.g. '/leaves/{{leave_id}}' — resolved at dispatch time by app layer

    -- State
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at          TIMESTAMP,

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_template_code_channel_company
        UNIQUE (company_id, template_code, channel),

    CONSTRAINT chk_template_notification_type
        CHECK (notification_type IN (
            'leave_request',
            'leave_status_update',
            'holiday_created',
            'holiday_request',
            'attendance_checkin_reminder',
            'attendance_checkout_reminder',
            'custom',
            'system'
        )),

    CONSTRAINT chk_template_channel
        CHECK (channel IN ('push', 'in_app', 'email', 'sms'))
);

CREATE INDEX IF NOT EXISTS idx_notif_templates_company_id
    ON notification_templates(company_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notif_templates_code_active
    ON notification_templates(template_code, channel)
    WHERE deleted_at IS NULL AND is_active = TRUE;

DROP TRIGGER IF EXISTS trg_notification_templates_updated_at ON notification_templates;
CREATE TRIGGER trg_notification_templates_updated_at
    BEFORE UPDATE ON notification_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 2. notifications
--    One row per notification "event" (the intent/source).
--    A single row fans out to many notification_recipients.
--
--    Examples:
--      • Admin creates holiday   → one row, audience = all_branch
--      • Cron fires shift remind → one row per employee (specific_employee)
--      • Leave approved          → one row, audience = specific_employee
--      • Custom blast            → one row, audience = all_company / all_branch
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Scope
    company_id              UUID            NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    branch_id               UUID                     REFERENCES branches(id)  ON DELETE SET NULL,
    -- NULL = company-wide; set = branch-scoped notification

    -- Originator (NULL for system / cron generated)
    created_by_user_id      UUID            REFERENCES users(id) ON DELETE SET NULL,

    -- Classification
    notification_type       VARCHAR(50)     NOT NULL,
    channel                 VARCHAR(20)     NOT NULL DEFAULT 'push',

    -- Template reference (NULL for fully ad-hoc custom notifications)
    template_id             UUID            REFERENCES notification_templates(id) ON DELETE SET NULL,

    -- Resolved content — stored after variable substitution at creation time
    title                   VARCHAR(255)    NOT NULL,
    body                    TEXT            NOT NULL,
    deep_link               VARCHAR(500),
    -- Resolved deep-link sent to mobile app e.g. '/leaves/abc-123'

    -- Entity reference (polymorphic) — what triggered this notification?
    -- e.g. entity_type='leave_requests', entity_id=<leave uuid>
    --      entity_type='holidays',       entity_id=<holiday uuid>
    --      entity_type='attendance',     entity_id=<attendance uuid>
    entity_type             VARCHAR(100),
    entity_id               UUID,

    -- ── Scheduling ───────────────────────────────────────────
    -- NULL  scheduled_at = send immediately (queued for next worker cycle)
    -- SET   scheduled_at = dispatch at or after this UTC timestamp
    scheduled_at            TIMESTAMP,
    -- Stored timezone used to compute scheduled_at — for display & audit
    timezone                VARCHAR(100)    NOT NULL DEFAULT 'UTC',

    -- Delivery window — do NOT dispatch outside these local-time bounds
    -- Critical for shift reminders: avoids sending a check-in alert at 3 AM
    delivery_window_start   TIME,           -- e.g. 06:00  (in notifications.timezone)
    delivery_window_end     TIME,           -- e.g. 22:00
    -- Both must be set together (enforced by constraint below)

    -- ── Recurrence (for cron-style repeating reminders) ──────
    -- NULL = one-shot notification
    -- SET  = standard cron expression e.g. '0 8 * * MON-FRI'
    recurrence_cron         VARCHAR(100),
    recurrence_end_at       TIMESTAMP,      -- stop recurring after this UTC timestamp

    -- ── Dispatch state (notification-level, not per-recipient) ─
    -- queued | processing | dispatched | partially_failed | cancelled
    dispatch_status         VARCHAR(30)     NOT NULL DEFAULT 'queued',
    dispatched_at           TIMESTAMP,      -- when fan-out to recipients began
    cancelled_at            TIMESTAMP,
    cancellation_reason     TEXT,

    -- State
    is_active               BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at              TIMESTAMP,

    -- Audit
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- ── Constraints ──────────────────────────────────────────
    CONSTRAINT chk_notif_type
        CHECK (notification_type IN (
            'leave_request',
            'leave_status_update',
            'holiday_created',
            'holiday_request',
            'attendance_checkin_reminder',
            'attendance_checkout_reminder',
            'custom',
            'system'
        )),

    CONSTRAINT chk_notif_channel
        CHECK (channel IN ('push', 'in_app', 'email', 'sms')),

    CONSTRAINT chk_notif_dispatch_status
        CHECK (dispatch_status IN (
            'queued', 'processing', 'dispatched', 'partially_failed', 'cancelled'
        )),

    -- Delivery window: either both bounds set, or neither
    CONSTRAINT chk_notif_delivery_window
        CHECK (
            (delivery_window_start IS NULL AND delivery_window_end IS NULL)
         OR (delivery_window_start IS NOT NULL AND delivery_window_end IS NOT NULL)
        )
);

-- ── Indexes ──────────────────────────────────────────────────

-- Scheduler polling: find queued notifications due for dispatch
CREATE INDEX IF NOT EXISTS idx_notifications_dispatch_queue
    ON notifications(dispatch_status, scheduled_at)
    WHERE dispatch_status = 'queued'
      AND deleted_at IS NULL
      AND is_active = TRUE;

-- Admin portal: all notifications for a company (newest first)
CREATE INDEX IF NOT EXISTS idx_notifications_company_id
    ON notifications(company_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- Branch-scoped notification lookup
CREATE INDEX IF NOT EXISTS idx_notifications_branch_id
    ON notifications(branch_id)
    WHERE deleted_at IS NULL AND branch_id IS NOT NULL;

-- Entity reference lookup: "all notifications triggered by leave #XYZ"
CREATE INDEX IF NOT EXISTS idx_notifications_entity
    ON notifications(entity_type, entity_id)
    WHERE entity_id IS NOT NULL;

-- Recurring notification management (cron scheduler)
CREATE INDEX IF NOT EXISTS idx_notifications_recurrence
    ON notifications(recurrence_cron)
    WHERE recurrence_cron IS NOT NULL
      AND deleted_at IS NULL
      AND is_active = TRUE;

DROP TRIGGER IF EXISTS trg_notifications_updated_at ON notifications;
CREATE TRIGGER trg_notifications_updated_at
    BEFORE UPDATE ON notifications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 3. notification_audience_rules
--    Defines WHO receives a notification before fan-out.
--    The worker resolves these rules into notification_recipients rows.
--
--    audience_type options:
--      all_company       → every active employee in the company
--      all_branch        → every active employee in a branch
--      specific_employee → single employee (e.g. the leave requester)
--      role_based        → all employees with a given role (e.g. 'admin')
--      department        → all employees in a department
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_audience_rules (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    notification_id         UUID            NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,

    -- Targeting strategy
    audience_type           VARCHAR(30)     NOT NULL,

    -- Target specifics — only the relevant field is set per audience_type
    target_branch_id        UUID            REFERENCES branches(id)     ON DELETE CASCADE,
    target_employee_id      UUID            REFERENCES employees(id)    ON DELETE CASCADE,
    target_role             VARCHAR(50),
    -- maps to user_companies.role — e.g. 'admin' | 'manager' | 'employee'
    target_department_id    UUID            REFERENCES departments(id)  ON DELETE CASCADE,

    -- Audit
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_audience_type
        CHECK (audience_type IN (
            'all_company',
            'all_branch',
            'specific_employee',
            'role_based',
            'department'
        ))
);

CREATE INDEX IF NOT EXISTS idx_notif_audience_notification_id
    ON notification_audience_rules(notification_id);


-- ============================================================
-- 4. notification_recipients
--    Per-employee per-channel delivery tracking row.
--    Fan-out: one notifications row → many notification_recipients rows.
--
--    Lifecycle: pending → sent → delivered → read
--                                         → failed (with retry)
--                                         → cancelled
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_recipients (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    notification_id     UUID            NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    employee_id         UUID            NOT NULL REFERENCES employees(id)     ON DELETE CASCADE,

    -- Denormalised for fast per-employee inbox queries (avoids join to notifications)
    company_id          UUID            NOT NULL REFERENCES companies(id)     ON DELETE CASCADE,

    -- Channel for this specific delivery
    channel             VARCHAR(20)     NOT NULL DEFAULT 'push',

    -- Push token snapshotted at send time
    -- (token rotation later won't corrupt historical delivery records)
    device_token        TEXT,

    -- Delivery lifecycle timestamps
    status              VARCHAR(20)     NOT NULL DEFAULT 'pending',
    sent_at             TIMESTAMP,      -- dispatched to FCM / APNS / email server
    delivered_at        TIMESTAMP,      -- provider confirmed delivery
    read_at             TIMESTAMP,      -- employee opened notification / in-app bell

    -- Failure & retry
    failed_at           TIMESTAMP,
    failure_reason      TEXT,
    retry_count         SMALLINT        NOT NULL DEFAULT 0,
    next_retry_at       TIMESTAMP,

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One delivery attempt per (notification × employee × channel)
    CONSTRAINT uq_notif_recipient_channel
        UNIQUE (notification_id, employee_id, channel),

    CONSTRAINT chk_recipient_channel
        CHECK (channel IN ('push', 'in_app', 'email', 'sms')),

    CONSTRAINT chk_recipient_status
        CHECK (status IN (
            'pending', 'sent', 'delivered', 'read', 'failed', 'cancelled'
        ))
);

-- ── Indexes ──────────────────────────────────────────────────

-- Worker polling: pending deliveries
CREATE INDEX IF NOT EXISTS idx_notif_recipients_pending
    ON notification_recipients(status, created_at)
    WHERE status = 'pending';

-- Retry queue
CREATE INDEX IF NOT EXISTS idx_notif_recipients_retry
    ON notification_recipients(next_retry_at, status)
    WHERE status = 'failed' AND next_retry_at IS NOT NULL;

-- Employee notification inbox (mobile app / web bell icon — newest first)
CREATE INDEX IF NOT EXISTS idx_notif_recipients_employee_inbox
    ON notification_recipients(employee_id, created_at DESC)
    WHERE status != 'cancelled';

-- Unread count badge query
CREATE INDEX IF NOT EXISTS idx_notif_recipients_unread
    ON notification_recipients(employee_id)
    WHERE status IN ('sent', 'delivered') AND read_at IS NULL;

-- Delivery analytics per notification event
CREATE INDEX IF NOT EXISTS idx_notif_recipients_notification_id
    ON notification_recipients(notification_id);

-- Company-level delivery report
CREATE INDEX IF NOT EXISTS idx_notif_recipients_company_id
    ON notification_recipients(company_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_notification_recipients_updated_at ON notification_recipients;
CREATE TRIGGER trg_notification_recipients_updated_at
    BEFORE UPDATE ON notification_recipients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 5. employee_device_tokens
--    FCM / APNs push tokens — one row per device per employee.
--    Token is upserted on every app login (device_id is the key).
--    Old tokens are deactivated (is_active = FALSE), not deleted,
--    so historical notification_recipients records remain intact.
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_device_tokens (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    employee_id     UUID            NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,
    company_id      UUID            NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,

    platform        VARCHAR(10)     NOT NULL,
    -- ios | android | web

    device_id       VARCHAR(255)    NOT NULL,
    -- unique device fingerprint / UUID from the mobile app

    push_token      TEXT            NOT NULL,
    -- FCM registration token or APNs device token

    app_version     VARCHAR(50),
    -- stored to help debug delivery issues on specific app versions

    -- State
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    last_used_at    TIMESTAMP,

    -- Audit
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One token record per employee per device (upsert on login)
    CONSTRAINT uq_device_token_employee_device
        UNIQUE (employee_id, device_id),

    CONSTRAINT chk_device_platform
        CHECK (platform IN ('ios', 'android', 'web'))
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_employee_id
    ON employee_device_tokens(employee_id)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_device_tokens_company_id
    ON employee_device_tokens(company_id)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_device_tokens_push_token
    ON employee_device_tokens(push_token)
    WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_employee_device_tokens_updated_at ON employee_device_tokens;
CREATE TRIGGER trg_employee_device_tokens_updated_at
    BEFORE UPDATE ON employee_device_tokens
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 6. notification_preferences
--    Per-employee opt-in/opt-out per notification_type per channel.
--    Row is created on first preference change; absence = opted in.
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    employee_id         UUID            NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,
    company_id          UUID            NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,

    notification_type   VARCHAR(50)     NOT NULL,
    channel             VARCHAR(20)     NOT NULL DEFAULT 'push',

    is_enabled          BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Employee-defined quiet hours (local time, interpreted in employee branch timezone)
    -- These override the system delivery_window on notifications table
    quiet_hours_start   TIME,           -- e.g. 22:00
    quiet_hours_end     TIME,           -- e.g. 07:00

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_notif_pref_employee_type_channel
        UNIQUE (employee_id, notification_type, channel),

    CONSTRAINT chk_pref_notification_type
        CHECK (notification_type IN (
            'leave_request',
            'leave_status_update',
            'holiday_created',
            'holiday_request',
            'attendance_checkin_reminder',
            'attendance_checkout_reminder',
            'custom',
            'system'
        )),

    CONSTRAINT chk_pref_channel
        CHECK (channel IN ('push', 'in_app', 'email', 'sms'))
);

CREATE INDEX IF NOT EXISTS idx_notif_prefs_employee_id
    ON notification_preferences(employee_id);

DROP TRIGGER IF EXISTS trg_notification_preferences_updated_at ON notification_preferences;
CREATE TRIGGER trg_notification_preferences_updated_at
    BEFORE UPDATE ON notification_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- SEED: Global system notification templates
-- company_id = NULL → available to all companies
-- Companies can override by inserting with their own company_id
-- for the same template_code + channel combination.
-- ============================================================

INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
) VALUES

-- ── Leave: employee submits a request (notify admin/manager) ──────────────
(NULL, 'leave_request_submitted', 'leave_request', 'push',
 '📋 New Leave Request',
 '{{employee_name}} has submitted a {{leave_type}} leave from {{start_date}} to {{end_date}}.',
 '/admin/leaves/{{leave_id}}'),

(NULL, 'leave_request_submitted', 'leave_request', 'in_app',
 'New Leave Request — {{employee_name}}',
 '{{employee_name}} ({{employee_code}}) applied for {{leave_type}} leave from {{start_date}} to {{end_date}}. Tap to review.',
 '/admin/leaves/{{leave_id}}'),

-- ── Leave: admin approves (notify employee) ───────────────────────────────
(NULL, 'leave_status_approved', 'leave_status_update', 'push',
 '✅ Leave Approved',
 'Your {{leave_type}} leave from {{start_date}} to {{end_date}} has been approved.',
 '/leaves/{{leave_id}}'),

(NULL, 'leave_status_approved', 'leave_status_update', 'in_app',
 'Your Leave Request Was Approved',
 'Good news! Your {{leave_type}} leave from {{start_date}} to {{end_date}} has been approved by {{approved_by}}.',
 '/leaves/{{leave_id}}'),

-- ── Leave: admin rejects (notify employee) ────────────────────────────────
(NULL, 'leave_status_rejected', 'leave_status_update', 'push',
 '❌ Leave Not Approved',
 'Your {{leave_type}} leave request ({{start_date}} – {{end_date}}) was not approved. Reason: {{rejection_reason}}.',
 '/leaves/{{leave_id}}'),

(NULL, 'leave_status_rejected', 'leave_status_update', 'in_app',
 'Leave Request Rejected',
 'Your {{leave_type}} leave from {{start_date}} to {{end_date}} was rejected by {{rejected_by}}. Reason: {{rejection_reason}}.',
 '/leaves/{{leave_id}}'),

-- ── Holiday: company/branch announces a holiday ───────────────────────────
(NULL, 'holiday_created', 'holiday_created', 'push',
 '🎉 Holiday: {{holiday_name}}',
 'A new holiday has been announced — {{holiday_name}} on {{holiday_date}}. Enjoy!',
 '/holidays/{{holiday_id}}'),

(NULL, 'holiday_created', 'holiday_created', 'in_app',
 'New Holiday Announced: {{holiday_name}}',
 '{{holiday_name}} has been added to the company calendar for {{holiday_date}}.',
 '/holidays/{{holiday_id}}'),

-- ── Holiday request (employee requests a day off as holiday) ──────────────
(NULL, 'holiday_request_submitted', 'holiday_request', 'push',
 '📅 Holiday Request',
 '{{employee_name}} has requested {{holiday_date}} as a holiday. Tap to review.',
 '/admin/holiday-requests/{{request_id}}'),

-- ── Attendance: check-in reminder (cron-driven per shift) ─────────────────
-- scheduled_at = shift.start_time - X minutes (computed in branch timezone)
(NULL, 'attendance_checkin_reminder', 'attendance_checkin_reminder', 'push',
 '⏰ Time to Check In',
 'Your shift starts at {{shift_start_time}}. Don''t forget to check in!',
 '/attendance/checkin'),

-- ── Attendance: check-out reminder (cron-driven per shift) ────────────────
(NULL, 'attendance_checkout_reminder', 'attendance_checkout_reminder', 'push',
 '🔔 Time to Check Out',
 'Your shift ends at {{shift_end_time}}. Please remember to check out.',
 '/attendance/checkout'),

-- ── Custom / admin ad-hoc blast ───────────────────────────────────────────
-- Placeholders are the resolved values (no substitution needed at dispatch)
(NULL, 'custom_notification', 'custom', 'push',
 '{{title}}',
 '{{body}}',
 '{{deep_link}}'),

(NULL, 'custom_notification', 'custom', 'in_app',
 '{{title}}',
 '{{body}}',
 '{{deep_link}}')

ON CONFLICT (company_id, template_code, channel) DO NOTHING;