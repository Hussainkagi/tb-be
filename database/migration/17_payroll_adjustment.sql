-- ============================================================
-- 08_payroll_adjustments.sql
-- Must run after 07_payroll.sql
-- Line-item adjustments linked to a payroll record
-- Covers bonuses, deductions, commissions, penalties, and loans
-- Deleted automatically when the parent payroll is deleted (CASCADE)
-- ============================================================

CREATE TABLE IF NOT EXISTS payroll_adjustments (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relations
    payroll_id              UUID            NOT NULL REFERENCES payrolls(id) ON DELETE CASCADE,

    -- Adjustment details
    adjustment_type         VARCHAR(50)     NOT NULL,   -- bonus/deduction/commission/penalty/loan
    title                   VARCHAR(255)    NOT NULL,
    amount                  NUMERIC(12,2)   NOT NULL,
    is_taxable              BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Misc
    remarks                 TEXT,

    -- Audit
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_payroll_id
    ON payroll_adjustments(payroll_id);

-- Filter by type within a payroll (e.g. fetch all bonuses)
CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_type
    ON payroll_adjustments(payroll_id, adjustment_type);

DROP TRIGGER IF EXISTS trg_payroll_adjustments_updated_at ON payroll_adjustments;
CREATE TRIGGER trg_payroll_adjustments_updated_at
    BEFORE UPDATE ON payroll_adjustments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();