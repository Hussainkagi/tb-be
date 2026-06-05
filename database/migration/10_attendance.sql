-- ============================================================
-- 10_attendance.sql
-- Must run after 08_employee.sql
-- Attendance records per employee per day
-- Tracks check-in/out times, locations, statuses, and hours worked
-- ============================================================

CREATE TABLE IF NOT EXISTS attendance (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relations
    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id               UUID            REFERENCES branches(id) ON DELETE SET NULL,
    employee_id             UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Date (one record per employee per calendar day in their shift timezone)
    attendance_date         DATE            NOT NULL,

    -- Check-In
    check_in                TIMESTAMP,
    check_in_latitude       DECIMAL(10,8),
    check_in_longitude      DECIMAL(11,8),
    check_in_address        TEXT,
    check_in_selfie         TEXT,                       -- file path / object storage key
    check_in_selfie_url     TEXT,                       -- optional public/presigned URL

    -- Check-Out
    check_out               TIMESTAMP,
    check_out_latitude      DECIMAL(10,8),
    check_out_longitude     DECIMAL(11,8),
    check_out_address       TEXT,
    check_out_selfie        TEXT,                       -- file path / object storage key
    check_out_selfie_url    TEXT,                       -- optional public/presigned URL

    -- Computed
    total_hours             NUMERIC(5,2),               -- derived from check_out - check_in
    attendance_status       VARCHAR(50),                -- on-time | before-time | late (NULL for week-off/holiday)

    -- Status
    -- checked-in | checked-out | absent | leave | holiday | week-off | comp-off
    status                  VARCHAR(50)     NOT NULL DEFAULT 'absent',

    -- Remarks / notes (manual override reason, admin notes, etc.)
    remarks                 TEXT,

    -- Audit
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One attendance record per employee per day
    CONSTRAINT uq_attendance_employee_date UNIQUE (employee_id, attendance_date)
);

-- ── Indexes ──────────────────────────────────────────────────

-- Primary lookup: all attendance for a company in a date range
CREATE INDEX IF NOT EXISTS idx_attendance_company_date
    ON attendance(company_id, attendance_date);

-- Per-employee history
CREATE INDEX IF NOT EXISTS idx_attendance_employee_id
    ON attendance(employee_id);

-- Branch-level reporting
CREATE INDEX IF NOT EXISTS idx_attendance_branch_id
    ON attendance(branch_id);

-- Date range scans (dashboards, exports)
CREATE INDEX IF NOT EXISTS idx_attendance_date
    ON attendance(attendance_date);

-- Status filter (e.g. fetch all absents for a company on a given day)
CREATE INDEX IF NOT EXISTS idx_attendance_status
    ON attendance(company_id, status, attendance_date);

-- Location map queries (only rows that have a check-in location)
CREATE INDEX IF NOT EXISTS idx_attendance_checkin_location
    ON attendance(company_id, attendance_date)
    WHERE check_in_latitude IS NOT NULL AND check_in_longitude IS NOT NULL;

-- ── Auto-update trigger ───────────────────────────────────────
DROP TRIGGER IF EXISTS trg_attendance_updated_at ON attendance;
CREATE TRIGGER trg_attendance_updated_at
    BEFORE UPDATE ON attendance
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();