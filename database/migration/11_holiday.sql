-- ============================================================
-- 05_holidays.sql
-- Must run after 02_branch.sql
--
-- Design decisions:
--   • is_company_wide = TRUE  → branch_id must be NULL  (applies to ALL branches)
--   • is_company_wide = FALSE → branch_id must be set   (branch-specific holiday)
--   • A CHECK constraint enforces the above — never both, never neither
--   • holiday_type supports future payroll rules (public days may be paid
--     differently from optional/religious holidays)
--   • Soft-delete (deleted_at) is consistent with companies / branches / employees
--   • Partial unique index prevents duplicate holidays per scope
-- ============================================================

CREATE TABLE IF NOT EXISTS holidays (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Ownership
    company_id          UUID            NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    branch_id           UUID                     REFERENCES branches(id)   ON DELETE CASCADE,
    -- NULL when is_company_wide = TRUE, required when is_company_wide = FALSE

    -- Identity
    holiday_name        VARCHAR(255)    NOT NULL,
    holiday_type        VARCHAR(50)     NOT NULL DEFAULT 'public',
    -- public | optional | religious | national | regional
    -- useful for payroll: e.g. optional holidays may not trigger overtime pay

    -- Duration
    holiday_start_date  DATE            NOT NULL,
    holiday_end_date    DATE            NOT NULL,

    -- Scope flag
    is_company_wide     BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Optional notes / reason for future audit trails
    description         TEXT,

    -- State
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at          TIMESTAMP,

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- --------------------------------------------------------
    -- Integrity constraints
    -- --------------------------------------------------------

    -- End date must be >= start date
    CONSTRAINT chk_holiday_dates
        CHECK (holiday_end_date >= holiday_start_date),

    -- Scope XOR:
    --   company-wide  → branch_id must be NULL
    --   branch-scoped → branch_id must be set
    CONSTRAINT chk_holiday_scope
        CHECK (
            (is_company_wide = TRUE  AND branch_id IS NULL)
         OR (is_company_wide = FALSE AND branch_id IS NOT NULL)
        ),

    -- holiday_type whitelist
    CONSTRAINT chk_holiday_type
        CHECK (holiday_type IN ('public', 'optional', 'religious', 'national', 'regional'))
);

-- --------------------------------------------------------
-- Indexes
-- --------------------------------------------------------

-- Primary lookup: all holidays for a company (used by payroll, attendance)
CREATE INDEX IF NOT EXISTS idx_holidays_company_id
    ON holidays(company_id)
    WHERE deleted_at IS NULL;

-- Branch-specific holiday lookup (used by attendance API per branch)
CREATE INDEX IF NOT EXISTS idx_holidays_branch_id
    ON holidays(branch_id)
    WHERE deleted_at IS NULL AND branch_id IS NOT NULL;

-- Date-range queries (e.g. "is today a holiday?")
CREATE INDEX IF NOT EXISTS idx_holidays_date_range
    ON holidays(company_id, holiday_start_date, holiday_end_date)
    WHERE deleted_at IS NULL AND is_active = TRUE;

-- --------------------------------------------------------
-- Unique constraints (prevent duplicate holidays per scope)
-- --------------------------------------------------------

-- No duplicate company-wide holiday with same name + start date
CREATE UNIQUE INDEX IF NOT EXISTS uq_holiday_company_wide
    ON holidays(company_id, holiday_name, holiday_start_date)
    WHERE is_company_wide = TRUE
      AND deleted_at IS NULL;

-- No duplicate branch holiday with same name + start date
CREATE UNIQUE INDEX IF NOT EXISTS uq_holiday_branch
    ON holidays(company_id, branch_id, holiday_name, holiday_start_date)
    WHERE is_company_wide = FALSE
      AND deleted_at IS NULL;

-- --------------------------------------------------------
-- Auto-update trigger (consistent with other tables)
-- --------------------------------------------------------

DROP TRIGGER IF EXISTS trg_holidays_updated_at ON holidays;
CREATE TRIGGER trg_holidays_updated_at
    BEFORE UPDATE ON holidays
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


