-- ============================================================
-- HRMS Departments Module
-- ============================================================


-- ------------------------------------------------------------
-- 1. DEPARTMENTS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS departments (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relationships
    company_id          UUID            NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    branch_id           UUID            NOT NULL REFERENCES branches(id)   ON DELETE CASCADE,

    -- Identity
    department_name     VARCHAR(255)    NOT NULL,

    -- State
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at          TIMESTAMP,                                          -- soft delete

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  
);

CREATE INDEX IF NOT EXISTS idx_departments_company_id
    ON departments(company_id);

CREATE INDEX IF NOT EXISTS idx_departments_branch_id
    ON departments(branch_id);

CREATE INDEX IF NOT EXISTS idx_departments_is_active
    ON departments(is_active)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- 2. AUTO-UPDATE updated_at via trigger
-- ------------------------------------------------------------

-- set_updated_at() is defined in 00_functions.sql — no need to redefine here.

CREATE TRIGGER trg_departments_updated_at
    BEFORE UPDATE ON departments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();