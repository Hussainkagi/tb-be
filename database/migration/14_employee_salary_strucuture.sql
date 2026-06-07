CREATE TABLE IF NOT EXISTS employee_salary_structures (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id             UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    effective_from          DATE NOT NULL,
    effective_to            DATE,

    actual_salary            NUMERIC(12,2) NOT NULL DEFAULT 0,
    housing_allowance       NUMERIC(12,2) NOT NULL DEFAULT 0,
    transport_allowance     NUMERIC(12,2) NOT NULL DEFAULT 0,
    other_allowance         NUMERIC(12,2) NOT NULL DEFAULT 0,

    overtime_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
    overtime_rate_per_hour  NUMERIC(10,2),

    payment_type            VARCHAR(50) NOT NULL DEFAULT 'monthly'
        CHECK (payment_type IN ('monthly', 'daily', 'hourly')),

    is_active               BOOLEAN NOT NULL DEFAULT TRUE,

    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_employee_salary_structures_updated_at ON employee_salary_structures;
CREATE TRIGGER trg_employee_salary_structures_updated_at
    BEFORE UPDATE ON employee_salary_structures
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();