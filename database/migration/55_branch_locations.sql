-- ============================================================
-- 55_branch_locations.sql
-- Must run after 54_task_comment_deleted_by.sql
--
-- Extra check-in sites for a branch. Staff who visit several fixed sites in a
-- day may check in or out at the branch's own location OR at any active site
-- listed here, each with its own radius. Anywhere else is still refused.
-- ============================================================

CREATE TABLE IF NOT EXISTS branch_locations (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id           UUID            NOT NULL REFERENCES branches(id)  ON DELETE CASCADE,

    location_name       VARCHAR(150)    NOT NULL,
    address             TEXT,
    latitude            DECIMAL(10,8)   NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
    longitude           DECIMAL(11,8)   NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    attendance_radius   INTEGER         NOT NULL DEFAULT 100 CHECK (attendance_radius BETWEEN 10 AND 10000), -- meters

    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at          TIMESTAMP
);

-- Check-in reads the active sites of one branch.
CREATE INDEX IF NOT EXISTS idx_branch_locations_branch
    ON branch_locations(branch_id)
    WHERE deleted_at IS NULL;

-- Two live sites of one branch cannot share a name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_locations_name
    ON branch_locations(branch_id, lower(location_name))
    WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_branch_locations_updated_at ON branch_locations;
CREATE TRIGGER trg_branch_locations_updated_at
    BEFORE UPDATE ON branch_locations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
