-- ============================================================
-- 06_leave_types.sql
-- Must run after 01_companies.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS leave_types (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Ownership
    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Identity
    leave_name              VARCHAR(100)    NOT NULL,
    -- e.g. "Annual Leave", "Sick Leave", "Maternity Leave"

    -- Entitlement
    total_days              INTEGER         NOT NULL CHECK (total_days > 0),
    is_paid                 BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Carry forward
    is_carry_forward        BOOLEAN         NOT NULL DEFAULT FALSE,
    max_carry_forward_days  INTEGER         CHECK (max_carry_forward_days >= 0),
    -- NULL = unlimited carry forward; only relevant when is_carry_forward = TRUE

    -- Request rules
    requires_document       BOOLEAN         NOT NULL DEFAULT FALSE,
    -- e.g. medical certificate for sick leave
    is_half_day_allowed     BOOLEAN         NOT NULL DEFAULT FALSE,

    -- State
    is_active               BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at              TIMESTAMP,

    -- Audit
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- --------------------------------------------------------
    -- Constraints
    -- --------------------------------------------------------

    CONSTRAINT chk_carry_forward_consistency
        CHECK (
            is_carry_forward = TRUE
            OR max_carry_forward_days IS NULL
        )
);

-- --------------------------------------------------------
-- Indexes
-- --------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_leave_types_company_id
    ON leave_types(company_id)
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_type_name
    ON leave_types(company_id, leave_name)
    WHERE deleted_at IS NULL;

-- --------------------------------------------------------
-- Auto-update trigger
-- --------------------------------------------------------

DROP TRIGGER IF EXISTS trg_leave_types_updated_at ON leave_types;
CREATE TRIGGER trg_leave_types_updated_at
    BEFORE UPDATE ON leave_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();