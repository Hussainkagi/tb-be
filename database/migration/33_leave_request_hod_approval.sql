-- ============================================================
-- 33_leave_request_hod_approval.sql
-- Two-stage leave approval: Head of Department → Admin
--
-- Flow for a regular employee who belongs to a department that HAS a head:
--     submit  →  approval_stage = 'hod'   (hod_status = 'pending')
--     HOD approves → approval_stage = 'admin'
--     Admin approves → status = 'approved', approval_stage = 'completed'
--
-- Flow for the head of department themselves, or an employee with no
-- department / a department with no head:
--     submit  →  approval_stage = 'admin'  (hod_status = 'not_required')
--     Admin approves → status = 'approved'
--
-- `status` keeps its original meaning — it stays 'pending' for the whole
-- approval journey and only becomes 'approved' when the admin signs off.
-- Payroll and reporting read `status`, so they need no changes.
-- ============================================================

ALTER TABLE leave_requests
    -- Who must act next
    ADD COLUMN IF NOT EXISTS approval_stage      VARCHAR(20) NOT NULL DEFAULT 'admin',

    -- HOD leg of the approval
    ADD COLUMN IF NOT EXISTS hod_status          VARCHAR(20) NOT NULL DEFAULT 'not_required',
    ADD COLUMN IF NOT EXISTS hod_employee_id     UUID REFERENCES employees(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS hod_approved_by     UUID REFERENCES users(id)     ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS hod_approved_at     TIMESTAMP,
    ADD COLUMN IF NOT EXISTS hod_rejection_reason TEXT,

    -- Department snapshot at submission time — the request must keep routing
    -- to the right department even if the employee is moved later.
    ADD COLUMN IF NOT EXISTS department_id       UUID REFERENCES departments(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_leave_approval_stage'
    ) THEN
        ALTER TABLE leave_requests
            ADD CONSTRAINT chk_leave_approval_stage
            CHECK (approval_stage IN ('hod', 'admin', 'completed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_leave_hod_status'
    ) THEN
        ALTER TABLE leave_requests
            ADD CONSTRAINT chk_leave_hod_status
            CHECK (hod_status IN ('not_required', 'pending', 'approved', 'rejected'));
    END IF;
END $$;

-- Backfill: everything that already exists was created under the
-- admin-only flow, so leave it there.
UPDATE leave_requests
SET approval_stage = CASE
        WHEN status IN ('approved', 'rejected', 'cancelled') THEN 'completed'
        ELSE 'admin'
    END,
    hod_status = 'not_required',
    department_id = COALESCE(
        department_id,
        (SELECT e.department_id FROM employees e WHERE e.id = leave_requests.employee_id)
    )
WHERE approval_stage IS NULL OR approval_stage = 'admin';

-- The HOD queue: "requests waiting for me"
CREATE INDEX IF NOT EXISTS idx_leave_requests_hod_queue
    ON leave_requests(hod_employee_id, approval_stage)
    WHERE deleted_at IS NULL;

-- The admin queue: "requests that cleared the HOD stage"
CREATE INDEX IF NOT EXISTS idx_leave_requests_approval_stage
    ON leave_requests(company_id, approval_stage)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leave_requests_department_id
    ON leave_requests(department_id)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- Notification templates for the new stage transitions.
-- notification_type stays 'leave_request' / 'leave_status_update'
-- so the existing CHECK constraints and preferences still apply.
-- ------------------------------------------------------------

INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
) VALUES

-- ── Leave: employee submits → notify the head of department ───────────────
(NULL, 'leave_request_hod_pending', 'leave_request', 'push',
 '📋 Leave Request To Review',
 '{{employee_name}} has requested {{leave_type}} leave from {{start_date}} to {{end_date}}. Your approval is needed.',
 '/hod/leaves/{{leave_id}}'),

(NULL, 'leave_request_hod_pending', 'leave_request', 'in_app',
 'Leave Request — {{employee_name}}',
 '{{employee_name}} ({{employee_code}}) applied for {{leave_type}} leave from {{start_date}} to {{end_date}}. Tap to approve or reject as head of {{department_name}}.',
 '/hod/leaves/{{leave_id}}'),

-- ── Leave: HOD approved → notify admin for the final call ─────────────────
(NULL, 'leave_request_admin_pending', 'leave_request', 'push',
 '📋 Leave Awaiting Final Approval',
 '{{employee_name}}''s {{leave_type}} leave ({{start_date}} – {{end_date}}) was approved by {{hod_name}} and needs your sign-off.',
 '/admin/leaves/{{leave_id}}'),

(NULL, 'leave_request_admin_pending', 'leave_request', 'in_app',
 'Leave Awaiting Final Approval — {{employee_name}}',
 '{{hod_name}} (head of {{department_name}}) approved {{employee_name}}''s {{leave_type}} leave from {{start_date}} to {{end_date}}. Tap to give final approval.',
 '/admin/leaves/{{leave_id}}'),

-- ── Leave: HOD approved → tell the employee they cleared stage one ────────
(NULL, 'leave_status_hod_approved', 'leave_status_update', 'push',
 '👍 Leave Approved By Your HOD',
 'Your {{leave_type}} leave ({{start_date}} – {{end_date}}) was approved by {{hod_name}} and is now awaiting admin approval.',
 '/leaves/{{leave_id}}'),

(NULL, 'leave_status_hod_approved', 'leave_status_update', 'in_app',
 'Head Of Department Approved Your Leave',
 'Your {{leave_type}} leave from {{start_date}} to {{end_date}} was approved by {{hod_name}}. It now needs final approval from the admin.',
 '/leaves/{{leave_id}}')

ON CONFLICT (company_id, template_code, channel) DO NOTHING;
