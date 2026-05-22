-- ============================================================
-- 09_payslips.sql
-- Must run after 07_payroll.sql
-- One payslip document per payroll record
-- Stores the generated PDF URL and a unique human-readable slip number
-- Deleted automatically when the parent payroll is deleted (CASCADE)
-- ============================================================

CREATE TABLE IF NOT EXISTS payslips (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relations
    payroll_id              UUID            NOT NULL REFERENCES payrolls(id) ON DELETE CASCADE,

    -- Slip identity
    payslip_number          VARCHAR(100)    UNIQUE NOT NULL,

    -- Document
    pdf_url                 TEXT,

    -- Audit
    generated_at            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One payslip per payroll record
    CONSTRAINT uq_payslip_payroll UNIQUE (payroll_id)
);

CREATE INDEX IF NOT EXISTS idx_payslips_payroll_id
    ON payslips(payroll_id);

DROP TRIGGER IF EXISTS trg_payslips_updated_at ON payslips;
CREATE TRIGGER trg_payslips_updated_at
    BEFORE UPDATE ON payslips
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();