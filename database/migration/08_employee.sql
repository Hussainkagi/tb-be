-- ============================================================
-- 03_employee.sql
-- Must run after 02_branch.sql
-- Employees belong to a company, branch, department, and optionally a shift
-- Self-referencing manager_id for org hierarchy
-- Country-specific documents handled in 04_employee_documents.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS employees (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relations
    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id               UUID            REFERENCES branches(id) ON DELETE RESTRICT,
    user_id                 UUID            REFERENCES users(id) ON DELETE SET NULL,
    shift_id                UUID            REFERENCES shifts(id) ON DELETE SET NULL,
    department_id           UUID            REFERENCES departments(id) ON DELETE SET NULL,
    manager_id              UUID            REFERENCES employees(id) ON DELETE SET NULL,

    -- Identity
    employee_code           VARCHAR(100)    ,
    first_name              VARCHAR(100)    NOT NULL,
    last_name               VARCHAR(100)    NOT NULL,
    email                   VARCHAR(255)    NOT NULL,
    phone                   VARCHAR(50)     ,

    -- Personal Info
    gender                  VARCHAR(20),
    date_of_birth           DATE,
    address                 TEXT,

    -- Employment
    joining_date            DATE,
    employment_type         VARCHAR(50),    -- full_time, part_time, contract, etc.
    status                  VARCHAR(50)     NOT NULL DEFAULT 'active',  -- active, inactive, terminated, on_leave

    -- Compensation
    basic_salary            NUMERIC(12,2),
    housing_allowance       NUMERIC(12,2)       NOT NULL DEFAULT 0.00,
    transport_allowance     NUMERIC(12,2)       NOT NULL DEFAULT 0.00,
    other_allowance         NUMERIC(12,2)       NOT NULL DEFAULT 0.00,

    gross_salary            NUMERIC(12,2)       GENERATED ALWAYS AS
                                (COALESCE(basic_salary, 0) + housing_allowance + transport_allowance + other_allowance)
                                STORED,

    -- Remote work
    is_remote_job           BOOLEAN             NOT NULL DEFAULT FALSE,

    -- Banking
    bank_name               VARCHAR(255),
    bank_account_number     VARCHAR(255),
    iban                    VARCHAR(255),

    -- State
    is_active               BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at              TIMESTAMP,

    -- Audit
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- employee_code unique within a company
    CONSTRAINT uq_employee_code_company UNIQUE (company_id, employee_code),


    -- one user can only have one employee profile per company
    CONSTRAINT uq_employee_user_company
    UNIQUE (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_employees_company_id
    ON employees(company_id);

CREATE INDEX IF NOT EXISTS idx_employees_branch_id
    ON employees(branch_id);

CREATE INDEX IF NOT EXISTS idx_employees_department_id
    ON employees(department_id);

CREATE INDEX IF NOT EXISTS idx_employees_manager_id
    ON employees(manager_id);

CREATE INDEX IF NOT EXISTS idx_employees_user_id
    ON employees(user_id);

CREATE INDEX IF NOT EXISTS idx_employees_shift_id
    ON employees(shift_id);

-- Soft-delete filter index
CREATE INDEX IF NOT EXISTS idx_employees_deleted_at
    ON employees(deleted_at)
    WHERE deleted_at IS NULL;

-- Status filter (e.g. fetch all active employees in a company)
CREATE INDEX IF NOT EXISTS idx_employees_status
    ON employees(company_id, status)
    WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_employees_updated_at ON employees;
CREATE TRIGGER trg_employees_updated_at
    BEFORE UPDATE ON employees
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();