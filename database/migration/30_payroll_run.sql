-- ============================================================
-- 30_payroll_run.sql
-- Must run after 16_payroll.sql, 18_payslip.sql, 20_payroll_daily_lines.sql
--
-- Turns payroll from five disconnected screens into ONE resumable run.
--
--   payroll_settings   → per-company payroll rules (sandwich, per-day basis,
--                        maker-checker toggles). Previously hard-coded.
--   payroll_runs       → the wizard state machine. One row per
--                        (period, branch). Holds current_step + status so a
--                        user who walks away can be dropped back exactly
--                        where they left off.
--   payroll_run_events → append-only audit trail of every step transition.
--                        This is what makes maker-checker defensible.
-- ============================================================


-- ------------------------------------------------------------
-- 1. PAYROLL SETTINGS (per company)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_settings (
    id                          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                  UUID            NOT NULL UNIQUE
                                    REFERENCES companies(id) ON DELETE CASCADE,

    -- How the per-day rate is derived from gross salary
    --   calendar_days → gross / days in the period      (week-offs are paid)
    --   fixed_30      → gross / 30                      (Gulf/KSA convention)
    --   working_days  → gross / non-week-off, non-holiday days
    per_day_basis               VARCHAR(20)     NOT NULL DEFAULT 'calendar_days'
                                    CHECK (per_day_basis IN ('calendar_days', 'fixed_30', 'working_days')),

    -- Sandwich-leave policy
    sandwich_enabled            BOOLEAN         NOT NULL DEFAULT TRUE,
    -- Which non-working days may be "bridged" into a sandwich
    sandwich_applies_to         VARCHAR(20)     NOT NULL DEFAULT 'week_off'
                                    CHECK (sandwich_applies_to IN ('week_off', 'holiday', 'both')),
    -- TRUE  → only a FULL-day loss on both sides triggers a sandwich.
    --         A half-day never bridges. This is the fix for
    --         "half day Sat + half day Mon ate my Sunday".
    sandwich_requires_full_day  BOOLEAN         NOT NULL DEFAULT TRUE,
    -- Longest bridge that can be swallowed (e.g. 2 = Sat+Sun, not a whole week)
    sandwich_max_bridge_days    INTEGER         NOT NULL DEFAULT 2
                                    CHECK (sandwich_max_bridge_days >= 0),

    -- A paid half-day leave means "half leave + half worked" → fully payable
    half_day_leave_is_payable   BOOLEAN         NOT NULL DEFAULT TRUE,
    -- Pay only from joining_date / up to exit_date instead of the whole period
    prorate_joiners_leavers     BOOLEAN         NOT NULL DEFAULT TRUE,
    -- Pay overtime for hours worked on a week-off / holiday
    overtime_on_off_days        BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Maker–checker
    require_approval            BOOLEAN         NOT NULL DEFAULT TRUE,
    allow_self_approval         BOOLEAN         NOT NULL DEFAULT FALSE,
    auto_email_payslips         BOOLEAN         NOT NULL DEFAULT TRUE,

    created_at                  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_payroll_settings_updated_at ON payroll_settings;
CREATE TRIGGER trg_payroll_settings_updated_at
    BEFORE UPDATE ON payroll_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 2. PAYROLL RUNS — the resumable flow
--
-- current_step lifecycle (forward only, except a rejection which
-- sends the run back to 'review'):
--   setup → generate → adjust → review → approval → payment → payslips → done
--
-- status lifecycle:
--   draft → in_progress → pending_approval → approved → paid → completed
--                              │
--                              └→ rejected → in_progress (maker reworks)
--   any non-terminal state → cancelled
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_runs (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    payroll_period_id       UUID            NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
    branch_id               UUID            REFERENCES branches(id) ON DELETE SET NULL,

    run_number              VARCHAR(60)     NOT NULL,

    current_step            VARCHAR(40)     NOT NULL DEFAULT 'setup'
                                CHECK (current_step IN (
                                    'setup', 'generate', 'adjust', 'review',
                                    'approval', 'payment', 'payslips', 'done'
                                )),

    status                  VARCHAR(30)     NOT NULL DEFAULT 'draft'
                                CHECK (status IN (
                                    'draft', 'in_progress', 'pending_approval',
                                    'approved', 'rejected', 'paid',
                                    'completed', 'cancelled'
                                )),

    -- Rolling totals, refreshed on every recalculation so the UI never
    -- has to sum thousands of payroll rows to render a header.
    employee_count          INTEGER         NOT NULL DEFAULT 0,
    total_gross             NUMERIC(14,2)   NOT NULL DEFAULT 0,
    total_deductions        NUMERIC(14,2)   NOT NULL DEFAULT 0,
    total_overtime          NUMERIC(14,2)   NOT NULL DEFAULT 0,
    total_bonus             NUMERIC(14,2)   NOT NULL DEFAULT 0,
    total_net               NUMERIC(14,2)   NOT NULL DEFAULT 0,

    -- Maker
    created_by              UUID            REFERENCES users(id) ON DELETE SET NULL,
    generated_by            UUID            REFERENCES users(id) ON DELETE SET NULL,
    generated_at            TIMESTAMP,
    submitted_by            UUID            REFERENCES users(id) ON DELETE SET NULL,
    submitted_at            TIMESTAMP,

    -- Checker
    approved_by             UUID            REFERENCES users(id) ON DELETE SET NULL,
    approved_at             TIMESTAMP,
    rejected_by             UUID            REFERENCES users(id) ON DELETE SET NULL,
    rejected_at             TIMESTAMP,
    rejection_reason        TEXT,

    -- Disbursement & delivery
    paid_by                 UUID            REFERENCES users(id) ON DELETE SET NULL,
    paid_at                 TIMESTAMP,
    payslips_generated_at   TIMESTAMP,
    payslips_sent_at        TIMESTAMP,
    completed_at            TIMESTAMP,

    cancelled_by            UUID            REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at            TIMESTAMP,

    notes                   TEXT,

    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One live run per (period, branch). branch_id IS NULL means "whole company",
-- and a plain UNIQUE would not catch duplicate NULLs — hence COALESCE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_run_period_branch
    ON payroll_runs (
        payroll_period_id,
        COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
    WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_payroll_runs_company_status
    ON payroll_runs(company_id, status);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_period
    ON payroll_runs(payroll_period_id);

DROP TRIGGER IF EXISTS trg_payroll_runs_updated_at ON payroll_runs;
CREATE TRIGGER trg_payroll_runs_updated_at
    BEFORE UPDATE ON payroll_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 3. PAYROLL RUN EVENTS — append-only audit trail
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payroll_run_events (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_run_id      UUID            NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,

    step                VARCHAR(40),
    action              VARCHAR(60)     NOT NULL,   -- created / generated / submitted / approved / rejected / paid …
    from_status         VARCHAR(30),
    to_status           VARCHAR(30),

    actor_user_id       UUID            REFERENCES users(id) ON DELETE SET NULL,
    actor_role          VARCHAR(20),                -- 'maker' | 'checker' | 'system'

    notes               TEXT,
    metadata            JSONB,

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payroll_run_events_run
    ON payroll_run_events(payroll_run_id, created_at DESC);


-- ------------------------------------------------------------
-- 4. PAYROLLS — link to the run + fix lossy day counters
--
-- total_present_days / total_absent_days were INTEGER while the engine
-- produces halves (0.5 for a half day). Every half day was silently
-- truncated on write.
-- ------------------------------------------------------------
ALTER TABLE payrolls
    ADD COLUMN IF NOT EXISTS payroll_run_id      UUID REFERENCES payroll_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sandwich_days       NUMERIC(6,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS payable_days        NUMERIC(6,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS not_employed_days   NUMERIC(6,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS per_day_salary      NUMERIC(12,4) NOT NULL DEFAULT 0;

ALTER TABLE payrolls
    ALTER COLUMN total_working_days TYPE NUMERIC(6,2),
    ALTER COLUMN total_present_days TYPE NUMERIC(6,2),
    ALTER COLUMN total_absent_days  TYPE NUMERIC(6,2),
    ALTER COLUMN total_holidays     TYPE NUMERIC(6,2);

CREATE INDEX IF NOT EXISTS idx_payrolls_run_id
    ON payrolls(payroll_run_id);

-- payroll_status was a free-text column; 'approved' and 'rejected' were
-- already being written by the bulk-status path without ever being declared.
ALTER TABLE payrolls DROP CONSTRAINT IF EXISTS chk_payroll_status;
ALTER TABLE payrolls
    ADD CONSTRAINT chk_payroll_status CHECK (
        payroll_status IN ('draft', 'processed', 'approved', 'rejected', 'paid', 'cancelled')
    );


-- ------------------------------------------------------------
-- 5. PAYROLL PERIODS — statuses that match the run lifecycle
-- ------------------------------------------------------------
ALTER TABLE payroll_periods DROP CONSTRAINT IF EXISTS payroll_periods_status_check;
ALTER TABLE payroll_periods
    ADD CONSTRAINT payroll_periods_status_check CHECK (
        status IN ('open', 'processing', 'pending_approval', 'approved', 'completed', 'locked')
    );


-- ------------------------------------------------------------
-- 6. PAYSLIPS — track email delivery so "send by email" is a
--    resumable, retryable step rather than a fire-and-forget click.
-- ------------------------------------------------------------
ALTER TABLE payslips
    ADD COLUMN IF NOT EXISTS payroll_run_id  UUID REFERENCES payroll_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS email_status    VARCHAR(20) NOT NULL DEFAULT 'pending'
                                CHECK (email_status IN ('pending', 'sent', 'failed', 'skipped')),
    ADD COLUMN IF NOT EXISTS email_sent_at   TIMESTAMP,
    ADD COLUMN IF NOT EXISTS email_error     TEXT,
    ADD COLUMN IF NOT EXISTS sent_to_email   VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_payslips_email_status
    ON payslips(payroll_run_id, email_status);


-- ------------------------------------------------------------
-- 7. DAILY LINES — carry the reason a day was classified the way
--    it was, so the breakdown screen can explain itself.
-- ------------------------------------------------------------
ALTER TABLE payroll_daily_lines
    ADD COLUMN IF NOT EXISTS attendance_status VARCHAR(40),
    ADD COLUMN IF NOT EXISTS remarks           TEXT;


-- ------------------------------------------------------------
-- 8. EMPLOYEES — an exit date is required to prorate a leaver's
--    final salary. Only joining_date existed.
-- ------------------------------------------------------------
ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS exit_date DATE;


-- ------------------------------------------------------------
-- 9. Seed default payroll settings for every existing company
-- ------------------------------------------------------------
INSERT INTO payroll_settings (company_id)
SELECT id FROM companies
ON CONFLICT (company_id) DO NOTHING;
