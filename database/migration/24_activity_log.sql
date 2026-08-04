-- ============================================================
-- 24_activity_log.sql
-- Must run after 23_super_admin.sql
--
-- Company-scoped activity trail. Every state-changing API call
-- (POST/PUT/PATCH/DELETE) that succeeds is recorded here by the
-- activityLogger middleware — no per-controller instrumentation.
--
-- Distinct from super_admin_audit_logs, which records only
-- PLATFORM-level actions (disable a company, grant super admin).
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_logs (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tenant. NULL only for pre-auth actions (registration, login attempts)
    -- where no company context exists yet.
    company_id          UUID            REFERENCES companies(id) ON DELETE CASCADE,

    -- Who did it (denormalised so the log survives user deletion)
    user_id             UUID            REFERENCES users(id) ON DELETE SET NULL,
    user_company_id     UUID,
    username            VARCHAR(10),
    actor_name          VARCHAR(255),
    role                VARCHAR(10),

    -- What happened
    action              VARCHAR(100)    NOT NULL,   -- e.g. employee.create, attendance.check-in
    entity_type         VARCHAR(100),               -- e.g. employee, branch, leave-request
    entity_id           UUID,                       -- the affected row, when the URL carries it

    -- Raw request context
    method              VARCHAR(10)     NOT NULL,
    path                TEXT            NOT NULL,
    status_code         SMALLINT        NOT NULL,
    is_success          BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Payload — secrets stripped, truncated to a sane size
    request_body        JSONB,
    error_message       TEXT,

    -- Client context
    ip_address          VARCHAR(64),
    user_agent          TEXT,
    duration_ms         INTEGER,

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── Indexes ──────────────────────────────────────────────────

-- Primary read path: one company's timeline, newest first
CREATE INDEX IF NOT EXISTS idx_activity_logs_company_created
    ON activity_logs(company_id, created_at DESC);

-- Platform-wide timeline for the super admin panel
CREATE INDEX IF NOT EXISTS idx_activity_logs_created
    ON activity_logs(created_at DESC);

-- "What has this person been doing?"
CREATE INDEX IF NOT EXISTS idx_activity_logs_user
    ON activity_logs(user_id, created_at DESC);

-- Filter a company's timeline by action type
CREATE INDEX IF NOT EXISTS idx_activity_logs_action
    ON activity_logs(company_id, action, created_at DESC);

-- "Show me the history of this one record"
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity
    ON activity_logs(entity_type, entity_id, created_at DESC)
    WHERE entity_id IS NOT NULL;

-- Failure triage
CREATE INDEX IF NOT EXISTS idx_activity_logs_failures
    ON activity_logs(company_id, created_at DESC)
    WHERE is_success = FALSE;
