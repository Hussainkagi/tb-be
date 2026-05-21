-- ============================================================
-- 05_payroll_period.sql
-- Must run after 01_company.sql and 03_employee.sql
-- Defines payroll periods per company
-- status lifecycle: open → processing → completed → locked
-- ============================================================

CREATE TABLE IF NOT EXISTS payroll_periods (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relations
    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Period definition
    period_name         VARCHAR(100)    NOT NULL,
    start_date          DATE            NOT NULL,
    end_date            DATE            NOT NULL,

    -- Status lifecycle
    status              VARCHAR(50)     NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'processing', 'completed', 'locked')),

    -- Processing audit
    processed_at        TIMESTAMP,
    processed_by        UUID            REFERENCES users(id) ON DELETE SET NULL,

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One period name per company
    CONSTRAINT uq_payroll_period_name_company
        UNIQUE (company_id, period_name),

    -- Periods within a company cannot overlap
    CONSTRAINT chk_payroll_period_dates
        CHECK (end_date > start_date)
);

CREATE INDEX IF NOT EXISTS idx_payroll_periods_company_id
    ON payroll_periods(company_id);

CREATE INDEX IF NOT EXISTS idx_payroll_periods_status
    ON payroll_periods(company_id, status);

CREATE INDEX IF NOT EXISTS idx_payroll_periods_dates
    ON payroll_periods(company_id, start_date, end_date);

DROP TRIGGER IF EXISTS trg_payroll_periods_updated_at ON payroll_periods;
CREATE TRIGGER trg_payroll_periods_updated_at
    BEFORE UPDATE ON payroll_periods
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();