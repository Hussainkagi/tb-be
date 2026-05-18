-- ============================================================
-- HRMS Shifts Module
-- ============================================================


-- ------------------------------------------------------------
-- 1. SHIFTS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shifts (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relationships
    company_id          UUID            NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    branch_id           UUID            NOT NULL REFERENCES branches(id)   ON DELETE CASCADE,

    -- Identity
    shift_name          VARCHAR(255)    NOT NULL,

    -- Timing
    start_time          TIME            NOT NULL,
    end_time            TIME            NOT NULL,

    -- Rules
    late_grace_minutes  INTEGER         NOT NULL DEFAULT 0,                 -- grace window before marking late
    half_day_hours      NUMERIC(5,2)    NOT NULL DEFAULT 0.00,             -- hours threshold for a half-day
    working_hours       NUMERIC(5,2)    NOT NULL DEFAULT 8.00,             -- expected full-day working hours
    is_night_shift      BOOLEAN         NOT NULL DEFAULT FALSE,             -- TRUE when shift crosses midnight

    -- Weekdays (attendance required)
    monday              BOOLEAN         NOT NULL DEFAULT TRUE,
    tuesday             BOOLEAN         NOT NULL DEFAULT TRUE,
    wednesday           BOOLEAN         NOT NULL DEFAULT TRUE,
    thursday            BOOLEAN         NOT NULL DEFAULT TRUE,
    friday              BOOLEAN         NOT NULL DEFAULT TRUE,
    saturday            BOOLEAN         NOT NULL DEFAULT FALSE,
    sunday              BOOLEAN         NOT NULL DEFAULT FALSE,

    -- State
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at          TIMESTAMP,                                          -- soft delete

    -- Audit
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT uq_shift_name_per_branch
        UNIQUE (company_id, branch_id, shift_name),

    CONSTRAINT chk_late_grace_minutes_non_negative
        CHECK (late_grace_minutes >= 0),

    CONSTRAINT chk_half_day_hours_non_negative
        CHECK (half_day_hours >= 0),

    CONSTRAINT chk_working_hours_positive
        CHECK (working_hours > 0)
);

CREATE INDEX IF NOT EXISTS idx_shifts_company_id
    ON shifts(company_id);

CREATE INDEX IF NOT EXISTS idx_shifts_branch_id
    ON shifts(branch_id);

CREATE INDEX IF NOT EXISTS idx_shifts_is_night_shift
    ON shifts(is_night_shift);

CREATE INDEX IF NOT EXISTS idx_shifts_is_active
    ON shifts(is_active)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- 2. AUTO-UPDATE updated_at via trigger
-- ------------------------------------------------------------

-- set_updated_at() is defined in 00_functions.sql — no need to redefine here.

CREATE OR REPLACE TRIGGER trg_shifts_updated_at
    BEFORE UPDATE ON shifts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();