-- ============================================================
-- 07_leave_requests.sql
-- Must run after 01_companies.sql, 02_branches.sql,
--               03_employees.sql, 06_leave_types.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS leave_requests (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Ownership
    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id           UUID            NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id         UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    leave_type_id       UUID            NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,

    -- Leave period
    from_date           DATE            NOT NULL,
    to_date             DATE            NOT NULL,
    total_days          NUMERIC(5, 2)   NOT NULL CHECK (total_days > 0),
    is_half_day         BOOLEAN         NOT NULL DEFAULT FALSE,

    -- Request details
    reason              TEXT            NOT NULL,
    document_url        VARCHAR(500),
    -- Required when leave_type.requires_document = TRUE

    -- Approval workflow
    status              VARCHAR(50)     NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    approved_by         UUID            REFERENCES users(id) ON DELETE SET NULL,
    approved_at         TIMESTAMP,
    rejection_reason    TEXT,
    -- Populated when status = 'rejected'

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at          TIMESTAMP,

    -- --------------------------------------------------------
    -- Constraints
    -- --------------------------------------------------------

    CONSTRAINT chk_leave_date_range
        CHECK (to_date >= from_date),

    CONSTRAINT chk_half_day_single_day
        CHECK (is_half_day = FALSE OR from_date = to_date),
    -- Half day must be a single day request

    CONSTRAINT chk_approval_consistency
        CHECK (
            (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
            OR (status != 'approved')
        ),

    CONSTRAINT chk_rejection_consistency
        CHECK (
            (status = 'rejected' AND rejection_reason IS NOT NULL)
            OR (status != 'rejected')
        )
);

-- --------------------------------------------------------
-- Indexes
-- --------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_leave_requests_company_id
    ON leave_requests(company_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leave_requests_branch_id
    ON leave_requests(branch_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leave_requests_employee_id
    ON leave_requests(employee_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leave_requests_leave_type_id
    ON leave_requests(leave_type_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leave_requests_status
    ON leave_requests(company_id, status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leave_requests_date_range
    ON leave_requests(company_id, from_date, to_date)
    WHERE deleted_at IS NULL;

-- --------------------------------------------------------
-- Auto-update trigger
-- --------------------------------------------------------

DROP TRIGGER IF EXISTS trg_leave_requests_updated_at ON leave_requests;
CREATE TRIGGER trg_leave_requests_updated_at
    BEFORE UPDATE ON leave_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();