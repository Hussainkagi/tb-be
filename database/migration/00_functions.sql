-- ============================================================
-- 00_functions.sql
-- Shared PostgreSQL functions used across all tables.
-- Run this FIRST before any table migrations.
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;