-- ============================================================
-- HRMS Companies Module
-- ============================================================


-- ------------------------------------------------------------
-- 1. COMPANIES
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identity
    company_name    VARCHAR(255)    NOT NULL,
    company_code    VARCHAR(50)     NOT NULL UNIQUE,    
    logo_url        TEXT,

    -- Contact
    email           VARCHAR(255)    NOT NULL,
    phone           VARCHAR(50),

    -- Locale
    country         VARCHAR(100),
    timezone        VARCHAR(100)    NOT NULL DEFAULT 'UTC',
    currency        VARCHAR(10)     NOT NULL DEFAULT 'USD',

    -- Subscription / plan (recommended for multi-company SaaS)
    plan            VARCHAR(50)     NOT NULL DEFAULT 'trial',   -- trial | basic | pro | enterprise
    plan_expires_at TIMESTAMP,

    -- State
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at      TIMESTAMP,                                  -- soft delete

    -- Audit
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_companies_company_code
    ON companies(company_code);

CREATE INDEX IF NOT EXISTS idx_companies_email
    ON companies(email);

CREATE INDEX IF NOT EXISTS idx_companies_is_active
    ON companies(is_active)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- 2. AUTO-UPDATE updated_at via trigger
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_companies_updated_at ON companies;
CREATE TRIGGER trg_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();