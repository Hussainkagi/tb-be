-- ============================================================
-- 04_employee_documents.sql
-- Must run after 03_employee.sql
-- Flexible key-value design for country-specific identity documents
-- Avoids nullable country-specific columns on the employees table
--
-- UAE  : document_type = 'emirates_id' | 'visa' | 'work_permit' | 'passport'
-- India: document_type = 'aadhaar'     | 'pan'  | 'pf_number'   | 'esi_number'
-- US   : document_type = 'ssn'         | 'i9'   | 'passport'
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_documents (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relations
    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id         UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Document Info
    -- e.g. 'emirates_id', 'passport', 'aadhaar', 'pan', 'ssn', 'visa', 'work_permit'
    document_type       VARCHAR(100)    NOT NULL,
    document_number     VARCHAR(255)    NOT NULL,

    issued_country      VARCHAR(100),
    issued_date         DATE,
    expiry_date         DATE,

    -- File Storage (S3 / any object storage URL)
    file_url            TEXT,                      
    file_name           VARCHAR(255),              

    -- State
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at          TIMESTAMP,

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One record per document type per employee (e.g. only one emirates_id per person)
    CONSTRAINT uq_employee_document_type UNIQUE (employee_id, document_type)
);

CREATE INDEX IF NOT EXISTS idx_employee_documents_employee_id
    ON employee_documents(employee_id);

CREATE INDEX IF NOT EXISTS idx_employee_documents_company_id
    ON employee_documents(company_id);

-- Fast expiry lookups (visa renewals, passport expiry alerts, etc.)
CREATE INDEX IF NOT EXISTS idx_employee_documents_expiry
    ON employee_documents(company_id, expiry_date)
    WHERE expiry_date IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_employee_documents_updated_at ON employee_documents;
CREATE TRIGGER trg_employee_documents_updated_at
    BEFORE UPDATE ON employee_documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();