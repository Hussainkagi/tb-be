-- ============================================================
-- 07_payroll.sql
-- Must run after 03_employee.sql, 05_payroll_periods.sql
-- Core payroll record per employee per payroll period
-- Tracks salary breakdown, attendance, overtime, deductions, and tax
-- ============================================================

CREATE TABLE IF NOT EXISTS payrolls (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relations
    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    payroll_period_id       UUID            NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
    employee_id             UUID            NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    branch_id               UUID            REFERENCES branches(id) ON DELETE SET NULL,

    -- Salary
    basic_salary            NUMERIC(12,2)   NOT NULL DEFAULT 0,
    gross_salary            NUMERIC(12,2)   NOT NULL DEFAULT 0,

    -- Attendance
    total_working_days      INTEGER         NOT NULL DEFAULT 0,
    total_present_days      INTEGER         NOT NULL DEFAULT 0,
    total_absent_days       INTEGER         NOT NULL DEFAULT 0,
    total_paid_leave_days   NUMERIC(5,2)    NOT NULL DEFAULT 0,
    total_unpaid_leave_days NUMERIC(5,2)    NOT NULL DEFAULT 0,
    total_holidays          INTEGER         NOT NULL DEFAULT 0,

    -- Overtime
    overtime_hours          NUMERIC(10,2)   NOT NULL DEFAULT 0,
    overtime_amount         NUMERIC(12,2)   NOT NULL DEFAULT 0,

    -- Earnings & Deductions
    bonus_amount            NUMERIC(12,2)   NOT NULL DEFAULT 0,
    deduction_amount        NUMERIC(12,2)   NOT NULL DEFAULT 0,
    tax_amount              NUMERIC(12,2)   NOT NULL DEFAULT 0,
    net_salary              NUMERIC(12,2)   NOT NULL DEFAULT 0,

    -- Status
    payroll_status          VARCHAR(50)     NOT NULL DEFAULT 'draft',  -- draft/processed/paid/cancelled

    -- Payment
    paid_at                 TIMESTAMP,

    -- Misc
    remarks                 TEXT,

    -- Audit
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One payroll record per employee per period
    CONSTRAINT uq_payroll_employee_period UNIQUE (employee_id, payroll_period_id)
);

CREATE INDEX IF NOT EXISTS idx_payrolls_company_id
    ON payrolls(company_id);

CREATE INDEX IF NOT EXISTS idx_payrolls_payroll_period_id
    ON payrolls(payroll_period_id);

CREATE INDEX IF NOT EXISTS idx_payrolls_employee_id
    ON payrolls(employee_id);

CREATE INDEX IF NOT EXISTS idx_payrolls_branch_id
    ON payrolls(branch_id);

-- Status filter (e.g. fetch all pending payrolls for a period)
CREATE INDEX IF NOT EXISTS idx_payrolls_status
    ON payrolls(company_id, payroll_status);

DROP TRIGGER IF EXISTS trg_payrolls_updated_at ON payrolls;
CREATE TRIGGER trg_payrolls_updated_at
    BEFORE UPDATE ON payrolls
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();