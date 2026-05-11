-- ============================================================
-- 02_branch.sql
-- Must run after 01_company.sql (branches belong to a company)
-- latitude/longitude + attendance_radius used for geofence check-in/out
-- ============================================================

CREATE TABLE IF NOT EXISTS branches (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Identity
    branch_name         VARCHAR(255)    NOT NULL,
    branch_code         VARCHAR(100)    NOT NULL,
    manager_name        VARCHAR(255),
    is_head_office      BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Location
    country             VARCHAR(100),
    state               VARCHAR(100),
    city                VARCHAR(100),
    address             TEXT,

    -- Contact
    phone               VARCHAR(50),
    email               VARCHAR(255),

    -- Geofence (for attendance check-in/out)
    latitude            DECIMAL(10,8),  -- e.g. 25.20484800
    longitude           DECIMAL(11,8),  -- e.g. 55.27012800
    attendance_radius   INTEGER         NOT NULL DEFAULT 100,  -- meters

    -- State
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at          TIMESTAMP,

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- branch_code unique within a company
    CONSTRAINT uq_branch_code_company UNIQUE (company_id, branch_code)
);

CREATE INDEX IF NOT EXISTS idx_branches_company_id
    ON branches(company_id);

CREATE INDEX IF NOT EXISTS idx_branches_deleted_at
    ON branches(deleted_at)
    WHERE deleted_at IS NULL;

-- Partial index for head office lookup (only one per company ideally)
CREATE INDEX IF NOT EXISTS idx_branches_head_office
    ON branches(company_id, is_head_office)
    WHERE is_head_office = TRUE;

CREATE TRIGGER trg_branches_updated_at
    BEFORE UPDATE ON branches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();