-- ============================================================
-- 02_branch.sql
-- Must run after 01_company.sql (branches belong to a company)
-- ============================================================

CREATE TABLE IF NOT EXISTS branches (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id      UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    branch_name     VARCHAR(255) NOT NULL,
    branch_code     VARCHAR(50)  NOT NULL,

    -- Contact
    email           VARCHAR(255),
    phone           VARCHAR(50),

    -- Location
    address         TEXT,
    city            VARCHAR(100),
    country         VARCHAR(100),
    timezone        VARCHAR(100) NOT NULL DEFAULT 'UTC',

    -- State
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    deleted_at      TIMESTAMP,

    -- Audit
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- branch_code unique within a company
    CONSTRAINT uq_branch_code_company UNIQUE (company_id, branch_code)
);

CREATE INDEX IF NOT EXISTS idx_branches_company_id
    ON branches(company_id);

CREATE INDEX IF NOT EXISTS idx_branches_deleted_at
    ON branches(deleted_at)
    WHERE deleted_at IS NULL;

CREATE TRIGGER trg_branches_updated_at
    BEFORE UPDATE ON branches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();