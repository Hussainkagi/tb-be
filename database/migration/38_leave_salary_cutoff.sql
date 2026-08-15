-- ============================================================
-- 38_leave_salary_cutoff.sql
-- Must run after 35_leave_salary.sql
--
-- THE CUTOFF DATE — going live with balances that already exist.
--
-- A company adopting the module rarely starts from zero. They have employees
-- with ten years of service and a spreadsheet saying who is owed what. The
-- module has always supported that per employee (opening_balance_days +
-- opening_balance_as_of), but onboarding a hundred people one form at a time is
-- not a workflow anybody completes.
--
-- The observation that makes it a bulk operation: the AS-OF DATE IS THE SAME
-- FOR EVERYONE. It is the day the company went live. Only the day counts differ
-- per employee. So the date moves up to the company config, and importing
-- balances becomes a two-column list — employee, days.
--
-- opening_balance_as_of stays on the employee row as an override, for the
-- late joiner reconciled on a different date. Company cutoff is the default,
-- not a replacement.
-- ============================================================

ALTER TABLE leave_salary_configs
    ADD COLUMN IF NOT EXISTS opening_balance_cutoff_date DATE;

COMMENT ON COLUMN leave_salary_configs.opening_balance_cutoff_date IS
    'Company go-live date for leave salary. Default as-of date for imported opening balances; accrual is only booked for months completing after it.';
