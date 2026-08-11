-- ============================================================
-- 32_department_head.sql
-- Department heads
--
-- One department can have at most ONE head, and the head must be an
-- employee that belongs to that same department.
--
-- A department with NO employees is allowed to have no head.
-- A department that HAS employees must have a head — that rule cannot be
-- expressed as a simple constraint (it depends on a count of another table),
-- so it is enforced in the service layer + surfaced through the
-- /departments/head-status endpoint.
-- ============================================================

ALTER TABLE departments
    ADD COLUMN IF NOT EXISTS head_employee_id UUID
        REFERENCES employees(id) ON DELETE SET NULL;

-- One employee can head at most one department
CREATE UNIQUE INDEX IF NOT EXISTS uq_department_head_employee
    ON departments(head_employee_id)
    WHERE head_employee_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_departments_head_employee_id
    ON departments(head_employee_id);
