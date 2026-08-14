-- ============================================================
-- 37_separation_exit_date_backfill.sql
-- Must run after 30_payroll_run.sql (adds employees.exit_date)
--               and 36_employee_separation.sql
--
-- employees.exit_date is what payroll reads to prorate a leaver's final month
-- (payroll_settings.prorate_joiners_leavers → payrollEngineService). The first
-- release of the separation module set the employee's status and is_active on
-- completion but left exit_date NULL, so any case approved or completed before
-- this migration would have paid a full final month for a month the employee
-- only partly worked.
--
-- The model now stamps exit_date at APPROVAL — the final payroll run usually
-- happens while the employee is still serving notice — and clears it if the
-- case is cancelled. This backfills the cases that already exist.
-- ============================================================

UPDATE employees e
SET exit_date = s.last_working_date
FROM employee_separations s
WHERE s.employee_id = e.id
  AND s.deleted_at IS NULL
  AND s.status IN ('approved', 'completed')
  AND s.last_working_date IS NOT NULL
  AND e.exit_date IS DISTINCT FROM s.last_working_date;

-- The mirror image: an exit_date left behind by a case that was later
-- cancelled, on an employee who is therefore still employed.
--
-- Deliberately narrow. exit_date passes straight through EmployeeModel.update,
-- so it can also be set by hand — and that is exactly how a company offboarded
-- people before this module existed. Clearing every exit_date without a live
-- case would wipe those, and payroll would start paying full final months to
-- staff who left a year ago.
--
-- So: only when the date can be ATTRIBUTED to a cancelled case (it matches that
-- case's last working date), the employee is still active, and no live case
-- explains it.
UPDATE employees e
SET exit_date = NULL
WHERE e.exit_date IS NOT NULL
  AND e.deleted_at IS NULL
  AND e.is_active = TRUE
  AND e.status = 'active'
  AND EXISTS (
        SELECT 1 FROM employee_separations s
        WHERE s.employee_id = e.id
          AND s.deleted_at IS NULL
          AND s.status IN ('cancelled', 'rejected', 'withdrawn')
          AND s.last_working_date = e.exit_date
  )
  AND NOT EXISTS (
        SELECT 1 FROM employee_separations s
        WHERE s.employee_id = e.id
          AND s.deleted_at IS NULL
          AND s.status IN ('pending', 'approved', 'completed')
  );
