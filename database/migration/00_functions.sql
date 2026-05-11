-- ============================================================
-- 00_functions.sql
-- Shared enums and functions — run FIRST before all tables
-- ============================================================

-- ------------------------------------------------------------
-- ENUMS
-- ------------------------------------------------------------

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('0', '1', '2');
    -- 0 = Admin | 1 = Manager | 2 = Employee
EXCEPTION
    WHEN duplicate_object THEN NULL;  -- safe to re-run
END $$;


-- ------------------------------------------------------------
-- FUNCTIONS
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;