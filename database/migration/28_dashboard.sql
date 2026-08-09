-- ============================================================
-- 28_dashboard.sql
-- Support objects for the company-admin dashboard.
--
-- Adds nothing to the data model — only a helper function and the
-- indexes the dashboard's aggregate queries lean on, so a bird's-eye
-- screen stays cheap as headcount grows.
-- ============================================================

-- ------------------------------------------------------------
-- 1. NEXT_OCCURRENCE(anchor, from_date)
--
-- The next time the month/day of `anchor` comes around on or after
-- `from_date`. Used for upcoming birthdays and work anniversaries.
--
-- 29 February is normalised to 28 February so make_date() never fails
-- on a non-leap year.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION next_occurrence(anchor DATE, from_date DATE)
RETURNS DATE AS $$
DECLARE
    m   INT;
    d   INT;
    y   INT;
    try DATE;
BEGIN
    IF anchor IS NULL OR from_date IS NULL THEN
        RETURN NULL;
    END IF;

    m := EXTRACT(MONTH FROM anchor)::INT;
    d := EXTRACT(DAY   FROM anchor)::INT;
    y := EXTRACT(YEAR  FROM from_date)::INT;

    IF m = 2 AND d = 29 THEN
        d := 28;
    END IF;

    try := make_date(y, m, d);

    IF try < from_date THEN
        try := make_date(y + 1, m, d);
    END IF;

    RETURN try;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------
-- 2. Indexes for dashboard aggregates
-- ------------------------------------------------------------

-- "Which employees have an active salary structure today" — the single
-- most repeated dashboard lookup (payroll readiness + gratuity basis).
CREATE INDEX IF NOT EXISTS idx_salary_structures_active_window
    ON employee_salary_structures(company_id, employee_id, effective_from DESC)
    WHERE is_active = TRUE;

-- Branch-wise attendance rollups group by the employee's branch, so the
-- join from attendance back to employees is always company-scoped.
CREATE INDEX IF NOT EXISTS idx_employees_company_branch_active
    ON employees(company_id, branch_id)
    WHERE deleted_at IS NULL AND is_active = TRUE;

-- Open shifts (checked in, never checked out) for the warnings panel.
CREATE INDEX IF NOT EXISTS idx_attendance_open_checkins
    ON attendance(company_id, attendance_date)
    WHERE check_in IS NOT NULL AND check_out IS NULL;

-- Upcoming birthdays / anniversaries scan only dated, active employees.
CREATE INDEX IF NOT EXISTS idx_employees_dob
    ON employees(company_id, date_of_birth)
    WHERE deleted_at IS NULL AND date_of_birth IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employees_joining_date
    ON employees(company_id, joining_date)
    WHERE deleted_at IS NULL AND joining_date IS NOT NULL;
