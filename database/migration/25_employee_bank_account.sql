-- ============================================================
-- 25_employee_bank_account.sql
-- Must run after 14_employee_salary_strucuture.sql
--
-- Bank details are OPTIONAL and attach to the salary flow.
--
-- Why a separate table instead of columns on the salary structure:
-- salary structures are versioned (a raise deactivates the old row and
-- inserts a new one). Bank details change on a different cadence, so
-- storing them inline would force re-entry on every raise and fragment
-- the history. Instead one account row per employee, linked FROM the
-- salary structure, so each salary version records which account was
-- paid to while the account itself survives salary revisions.
--
-- work_country drives WHICH bank fields are required — an employee of a
-- Dubai company may be working from (and banking in) India. The salary
-- AMOUNT is always in the company's own currency; only the destination
-- account differs.
-- ============================================================

-- ------------------------------------------------------------
-- 1. EMPLOYEE BANK ACCOUNTS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_bank_accounts (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id             UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Which country's banking format this account follows (ISO 3166-1 alpha-2).
    -- Also answers "where is this employee working from".
    work_country            VARCHAR(2)      NOT NULL,

    -- Informational only: the currency the destination account holds.
    -- Salary is ALWAYS defined in the company's currency — no FX is performed.
    account_currency        VARCHAR(10),

    -- ── Common fields (used by most countries) ──────────────
    account_holder_name     VARCHAR(255)    NOT NULL,
    bank_name               VARCHAR(255)    NOT NULL,
    branch_name             VARCHAR(255),
    bank_address            TEXT,
    account_number          VARCHAR(64),
    account_type            VARCHAR(20),    -- current | savings | checking

    -- ── Country-specific identifiers ────────────────────────
    iban                    VARCHAR(64),    -- AE, SA, PK, EU
    swift_bic               VARCHAR(20),    -- international transfers
    ifsc_code               VARCHAR(20),    -- India
    routing_number          VARCHAR(20),    -- US (ABA), BD
    sort_code               VARCHAR(20),    -- UK
    bank_code               VARCHAR(20),    -- LK and others

    -- Anything a country needs that has no dedicated column
    extra                   JSONB           NOT NULL DEFAULT '{}'::JSONB,

    -- ── State ───────────────────────────────────────────────
    is_primary              BOOLEAN         NOT NULL DEFAULT TRUE,
    is_active               BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at              TIMESTAMP,

    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_bank_account_type
        CHECK (account_type IS NULL OR account_type IN ('current', 'savings', 'checking'))
);

CREATE INDEX IF NOT EXISTS idx_employee_bank_accounts_employee
    ON employee_bank_accounts(employee_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_employee_bank_accounts_company
    ON employee_bank_accounts(company_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_employee_bank_accounts_country
    ON employee_bank_accounts(company_id, work_country)
    WHERE deleted_at IS NULL;

-- Exactly one primary account per employee
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_primary_bank_account
    ON employee_bank_accounts(employee_id)
    WHERE is_primary = TRUE AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_employee_bank_accounts_updated_at ON employee_bank_accounts;
CREATE TRIGGER trg_employee_bank_accounts_updated_at
    BEFORE UPDATE ON employee_bank_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 2. SALARY STRUCTURE — link + context
-- ------------------------------------------------------------

ALTER TABLE employee_salary_structures
    -- Where the employee works from. Drives the bank-detail format.
    ADD COLUMN IF NOT EXISTS work_country     VARCHAR(2),

    -- Snapshot of companies.currency at creation time, so a historical
    -- salary row stays unambiguous even if the company later switches currency.
    -- NEVER taken from client input.
    ADD COLUMN IF NOT EXISTS salary_currency  VARCHAR(10),

    -- Optional: the account this salary is paid into.
    ADD COLUMN IF NOT EXISTS bank_account_id  UUID
        REFERENCES employee_bank_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_salary_structures_bank_account
    ON employee_salary_structures(bank_account_id)
    WHERE bank_account_id IS NOT NULL;

-- Backfill salary_currency for rows created before this migration
UPDATE employee_salary_structures ess
SET salary_currency = c.currency
FROM companies c
WHERE c.id = ess.company_id
  AND ess.salary_currency IS NULL;
