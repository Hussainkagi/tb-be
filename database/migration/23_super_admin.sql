-- ============================================================
-- 23_super_admin.sql
-- Must run after 01_company.sql and 03_user.sql
--
-- Super Admin is a PLATFORM-level flag on the global `users` row,
-- NOT a per-company role. A super admin keeps their normal
-- `user_companies.role = '0'` (Admin) membership in their own
-- company and additionally gets read access to every company
-- plus the ability to disable/enable a company.
--
-- Promote from query:
--   UPDATE users SET is_super_admin = TRUE WHERE email IN ('a@x.com','b@x.com');
-- ============================================================

-- ------------------------------------------------------------
-- 1. USERS — platform super admin flag
-- ------------------------------------------------------------

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_users_is_super_admin
    ON users(is_super_admin)
    WHERE is_super_admin = TRUE;


-- ------------------------------------------------------------
-- 2. COMPANIES — disable metadata
--    `is_active = FALSE` is the disabled state (column already exists).
--    These columns record WHO disabled it, WHEN and WHY.
-- ------------------------------------------------------------

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS disabled_at     TIMESTAMP,
    ADD COLUMN IF NOT EXISTS disabled_reason TEXT,
    ADD COLUMN IF NOT EXISTS disabled_by     UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_companies_disabled_at
    ON companies(disabled_at)
    WHERE disabled_at IS NOT NULL;


-- ------------------------------------------------------------
-- 3. SUPER ADMIN AUDIT LOG
--    Every state-changing super admin action is recorded here.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS super_admin_audit_logs (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Who
    actor_user_id       UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- What
    action              VARCHAR(100)    NOT NULL,
    -- company.disable | company.enable | company.plan_update
    -- | super_admin.grant | super_admin.revoke

    -- On which target
    target_company_id   UUID            REFERENCES companies(id) ON DELETE SET NULL,
    target_user_id      UUID            REFERENCES users(id)     ON DELETE SET NULL,

    -- Context
    reason              TEXT,
    metadata            JSONB           NOT NULL DEFAULT '{}'::JSONB,
    ip_address          VARCHAR(64),

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sa_audit_actor
    ON super_admin_audit_logs(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sa_audit_company
    ON super_admin_audit_logs(target_company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sa_audit_action
    ON super_admin_audit_logs(action, created_at DESC);


-- ------------------------------------------------------------
-- 4. Supporting indexes for cross-company analytics
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_attendance_company_status_date
    ON attendance(company_id, attendance_date, attendance_status);
