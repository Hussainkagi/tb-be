-- ============================================================
-- HRMS Backup & Restore Module
-- ============================================================
--
-- Two tables:
--
--   company_backup_settings  one row per company — the monthly emailed
--                             backup opt-in and which day of the month it
--                             fires on. last_scheduled_month makes the hourly
--                             cron sweep (jobs/backupExportJob.js) idempotent
--                             the same way jobs/birthdayNotificationJob.js
--                             uses a unique index — here one dispatch fans out
--                             to N admins rather than inserting one row, so a
--                             stamped column does the job instead.
--
--   company_data_jobs        every backup EXPORT and RESTORE, scheduled or
--                             manual. Doubles as the once-a-week throttle
--                             ledger for manual exports (see
--                             service/backupService.js: checkWeeklyThrottle)
--                             and as the audit trail an admin sees in the
--                             Backup settings page.
--
-- Gated behind the data.backup_restore plan feature — see the seed at the
-- bottom of this file and enums/features.js.
-- ============================================================


-- ------------------------------------------------------------
-- 1. COMPANY BACKUP SETTINGS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS company_backup_settings (
    company_id              UUID            PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,

    is_enabled              BOOLEAN         NOT NULL DEFAULT FALSE,
    day_of_month            SMALLINT        NOT NULL DEFAULT 1,

    -- 'YYYY-MM' of the last scheduled dispatch, so the hourly sweep never
    -- emails the same company's monthly backup twice in one month.
    last_scheduled_month    VARCHAR(7),

    updated_by              UUID            REFERENCES users(id) ON DELETE SET NULL,

    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Capped at 28 deliberately — every month has a 28th, so a company that
    -- picks a day near month-end never gets a shifting, ambiguous schedule.
    CONSTRAINT chk_backup_day_of_month CHECK (day_of_month BETWEEN 1 AND 28)
);

DROP TRIGGER IF EXISTS trg_company_backup_settings_updated_at ON company_backup_settings;
CREATE TRIGGER trg_company_backup_settings_updated_at
    BEFORE UPDATE ON company_backup_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 2. BACKUP / RESTORE JOBS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS company_data_jobs (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id      UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    job_type        VARCHAR(20)     NOT NULL,           -- export | restore
    trigger_type    VARCHAR(20)     NOT NULL,           -- scheduled | manual

    status          VARCHAR(20)     NOT NULL DEFAULT 'queued', -- queued | processing | completed | failed

    scope           JSONB           NOT NULL DEFAULT '[]'::JSONB, -- section keys included
    requested_by    UUID            REFERENCES users(id) ON DELETE SET NULL, -- NULL for scheduled jobs

    file_bytes      INT,
    summary         JSONB,          -- per-section row counts once complete
    error_message   TEXT,

    started_at      TIMESTAMP,
    completed_at    TIMESTAMP,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_cdj_job_type     CHECK (job_type IN ('export', 'restore')),
    CONSTRAINT chk_cdj_trigger_type CHECK (trigger_type IN ('scheduled', 'manual')),
    CONSTRAINT chk_cdj_status       CHECK (status IN ('queued', 'processing', 'completed', 'failed'))
);

-- Weekly-throttle lookup: latest manual export for a company.
CREATE INDEX IF NOT EXISTS idx_cdj_company_type_trigger
    ON company_data_jobs(company_id, job_type, trigger_type, created_at DESC);

-- Settings-page job history + "is anything still running" checks.
CREATE INDEX IF NOT EXISTS idx_cdj_company_status
    ON company_data_jobs(company_id, status);


-- ============================================================
-- 3. SEED — plan feature catalog + grid
-- ============================================================
--
-- Sits between data.self_service_export (720) and data.extended_retention
-- (730) in the existing Data & Storage category from
-- 34_plans_and_entitlements.sql.

INSERT INTO plan_features (key, category, label, value_type, is_enforceable, is_visible, sort_order) VALUES
    ('data.backup_restore', 'Data & Storage', 'Monthly & on-demand full data backup + restore', 'boolean', TRUE, TRUE, 725)
ON CONFLICT (key) DO UPDATE SET
    category       = EXCLUDED.category,
    label          = EXCLUDED.label,
    value_type     = EXCLUDED.value_type,
    is_enforceable = EXCLUDED.is_enforceable,
    is_visible     = EXCLUDED.is_visible,
    sort_order     = EXCLUDED.sort_order;

-- Premium only: off for Trial, on for Pro and Gold.
WITH seed(plan_code, feature_key, bool_value, limit_value, is_unlimited, json_value, note) AS (
    VALUES
    ('trial', 'data.backup_restore', FALSE, NULL::INT, FALSE, NULL::JSONB, NULL::TEXT),
    ('pro',   'data.backup_restore', TRUE,  NULL::INT, FALSE, NULL::JSONB, NULL::TEXT),
    ('gold',  'data.backup_restore', TRUE,  NULL::INT, FALSE, NULL::JSONB, NULL::TEXT)
)
INSERT INTO plan_feature_values (plan_id, feature_key, bool_value, limit_value, is_unlimited, json_value, note)
SELECT p.id, s.feature_key, s.bool_value, s.limit_value, s.is_unlimited, s.json_value, s.note
FROM seed s
JOIN plans p ON p.code = s.plan_code
ON CONFLICT (plan_id, feature_key) DO NOTHING;
