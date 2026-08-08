-- ============================================================
-- 27_employee_gratuity.sql
-- Must run after 14_employee_salary_strucuture.sql
--
-- End-of-service gratuity (EOSB).
--
-- Design: a config row is OPTIONAL. When absent, the calculation falls
-- back to the statutory preset for the employee's work_country (see
-- enums/gratuityRules.js), so UAE staff accrue correctly out of the box.
-- A row exists only when someone overrides something for that employee.
--
-- Nothing is precomputed or stored as a balance — the accrued amount is
-- derived on read from service length x basis salary. Storing it would
-- go stale the moment a salary changes.
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_gratuity_configs (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id             UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Turn accrual off for an employee the scheme doesn't apply to
    is_enabled              BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Which statutory rule set to start from (ISO2, e.g. 'AE', 'IN')
    rule_country            VARCHAR(2)      NOT NULL,

    -- ── What the calculation is based on ────────────────────
    -- basic  → salary structure basic_salary   (UAE law: basic only)
    -- gross  → salary structure actual_salary
    -- custom → custom_basis_amount below
    calculation_basis       VARCHAR(20)     NOT NULL DEFAULT 'basic',
    custom_basis_amount     NUMERIC(12,2),

    -- Overrides employees.joining_date when service started elsewhere
    -- (transfers, acquisitions, re-hires with continuous service).
    service_start_date      DATE,

    -- ── Rule parameters (override the country preset) ───────
    min_service_years       NUMERIC(4,2)    NOT NULL DEFAULT 1,
    days_in_month           INTEGER         NOT NULL DEFAULT 30,

    -- [{ "up_to_years": 5, "days_per_year": 21 }, { "up_to_years": null, "days_per_year": 30 }]
    -- up_to_years = null means "and everything beyond"
    tiers                   JSONB           NOT NULL,

    -- Cap expressed in years of salary (UAE: 2 years' wages)
    max_years_cap           NUMERIC(4,2),
    -- Absolute currency cap (India: 2,000,000 INR)
    max_amount_cap          NUMERIC(14,2),

    -- none    → use the exact fraction of a year
    -- half_up → >= 6 months counts as a full year (India)
    year_rounding           VARCHAR(10)     NOT NULL DEFAULT 'none',

    -- Pay a pro-rata amount for part-years beyond the eligibility threshold
    prorate_partial_years   BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Deduct approved unpaid-leave days from the service period
    exclude_unpaid_leave    BOOLEAN         NOT NULL DEFAULT FALSE,

    notes                   TEXT,

    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at              TIMESTAMP,

    CONSTRAINT uq_gratuity_config_employee UNIQUE (employee_id),

    CONSTRAINT chk_gratuity_basis
        CHECK (calculation_basis IN ('basic', 'gross', 'custom')),

    CONSTRAINT chk_gratuity_custom_amount
        CHECK (calculation_basis <> 'custom' OR custom_basis_amount IS NOT NULL),

    CONSTRAINT chk_gratuity_year_rounding
        CHECK (year_rounding IN ('none', 'half_up')),

    CONSTRAINT chk_gratuity_days_in_month
        CHECK (days_in_month > 0 AND days_in_month <= 31),

    CONSTRAINT chk_gratuity_min_service
        CHECK (min_service_years >= 0)
);

CREATE INDEX IF NOT EXISTS idx_gratuity_configs_company
    ON employee_gratuity_configs(company_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gratuity_configs_employee
    ON employee_gratuity_configs(employee_id)
    WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_employee_gratuity_configs_updated_at ON employee_gratuity_configs;
CREATE TRIGGER trg_employee_gratuity_configs_updated_at
    BEFORE UPDATE ON employee_gratuity_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
