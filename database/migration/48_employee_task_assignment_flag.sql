-- ============================================================
-- Per-employee task-assignment bypass
-- ============================================================
--
-- Normally only an admin (any employee) or a head of department (their own
-- department) may assign a task. This flag lets an admin grant a specific
-- employee the same company-wide assignment reach without making them an
-- admin or a department head — see
-- backend/service/Task/taskAccessService.js:canAssignTo.
-- ============================================================

ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS can_assign_tasks BOOLEAN NOT NULL DEFAULT FALSE;
