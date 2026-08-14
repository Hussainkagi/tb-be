-- ============================================================
-- 36_employee_separation.sql
-- Must run after 08_employee.sql, 27_employee_gratuity.sql,
--               34_plans_and_entitlements.sql, 35_leave_salary.sql
--
-- RESIGNATION & TERMINATION — one workflow, two entry points.
--
-- Resignation and termination differ in who starts them and which fields they
-- carry, but from the decision onwards they are the same process: a last
-- working date, a notice period, a final settlement, and an employee record
-- that stops being active. Two tables would mean two copies of the settlement
-- logic and two ways for an employee to end up half-offboarded, so this is one
-- table with a discriminator plus per-type CHECKs.
--
--   resignation   employee submits  → admin approves  → notice → completed
--   termination   admin initiates   → admin approves  → notice → completed
--
-- Nothing here writes to employees.status until the case is COMPLETED. An
-- employee serving notice is still an active employee: they check in, they
-- appear on payroll, they take leave. Deactivating them at submission would
-- strand a month of attendance and payroll.
--
-- Legal note (UAE Federal Decree-Law 33/2021): notice is 30-90 days
-- (Art. 43), gratuity is payable on resignation as well as termination
-- (Art. 51), and is forfeited only on dismissal for the causes in Art. 44.
-- is_gratuity_forfeited is therefore an explicit, reasoned decision — never a
-- side effect of the separation type.
-- ============================================================


-- ------------------------------------------------------------
-- 1. THE CASE
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_separations (
    id                          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id                  UUID          NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    employee_id                 UUID          NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,
    branch_id                   UUID          REFERENCES branches(id)            ON DELETE SET NULL,
    department_id               UUID          REFERENCES departments(id)         ON DELETE SET NULL,

    separation_type             VARCHAR(20)   NOT NULL,   -- resignation | termination

    -- ── Workflow ────────────────────────────────────────────
    -- pending   → awaiting the admin decision
    -- approved  → accepted, employee is serving notice
    -- rejected  → resignation declined / termination not proceeded with
    -- withdrawn → employee pulled their own resignation before a decision
    -- cancelled → an approved case revoked; the employee stays employed
    -- completed → last working day passed, settlement recorded, access closed
    status                      VARCHAR(20)   NOT NULL DEFAULT 'pending',

    -- ── Submission ──────────────────────────────────────────
    reason                      TEXT          NOT NULL,
    submitted_by                UUID          REFERENCES users(id) ON DELETE SET NULL,
    submitted_at                TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- What the employee (or the admin, for a termination) asked for. Kept
    -- separate from last_working_date so a negotiated exit date stays visible
    -- next to the date originally requested.
    requested_last_working_date DATE,

    notice_period_days          INTEGER       NOT NULL DEFAULT 30,
    notice_start_date           DATE,

    -- ── Resignation-only ────────────────────────────────────
    -- A waived notice is a decision with a cost attached, so it is recorded
    -- rather than inferred from the dates.
    is_notice_waived            BOOLEAN       NOT NULL DEFAULT FALSE,
    notice_shortfall_days       NUMERIC(6,2)  NOT NULL DEFAULT 0,

    -- ── Termination-only ────────────────────────────────────
    termination_type            VARCHAR(30),  -- see chk_sep_termination_type
    is_gratuity_forfeited       BOOLEAN       NOT NULL DEFAULT FALSE,
    forfeiture_reason           TEXT,

    -- ── Decision ────────────────────────────────────────────
    last_working_date           DATE,
    decided_by                  UUID          REFERENCES users(id) ON DELETE SET NULL,
    decided_at                  TIMESTAMP,
    decision_notes              TEXT,
    rejection_reason            TEXT,

    withdrawn_at                TIMESTAMP,
    withdrawal_reason           TEXT,
    cancelled_at                TIMESTAMP,
    cancellation_reason         TEXT,

    -- ── Completion ──────────────────────────────────────────
    -- Free-form so a company can carry its own exit checklist without a
    -- migration per item: [{ "item": "Laptop returned", "done": true }]
    clearance_checklist         JSONB         NOT NULL DEFAULT '[]'::JSONB,
    exit_interview_notes        TEXT,
    completed_at                TIMESTAMP,
    completed_by                UUID          REFERENCES users(id) ON DELETE SET NULL,

    -- Whether the employee is welcome back. The one field HR always wants and
    -- nobody records at the time.
    is_rehire_eligible          BOOLEAN,

    created_at                  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at                  TIMESTAMP,

    CONSTRAINT chk_sep_type
        CHECK (separation_type IN ('resignation', 'termination')),

    CONSTRAINT chk_sep_status
        CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled', 'completed')),

    CONSTRAINT chk_sep_termination_type
        CHECK (
            separation_type <> 'termination'
            OR termination_type IN ('with_cause', 'without_cause', 'probation',
                                    'redundancy', 'contract_end', 'absconded',
                                    'retirement', 'death')
        ),

    -- Only a termination can forfeit gratuity, and only with a stated cause.
    CONSTRAINT chk_sep_forfeiture_reason
        CHECK (
            is_gratuity_forfeited = FALSE
            OR (separation_type = 'termination' AND forfeiture_reason IS NOT NULL)
        ),

    -- An approved case must have the date everything downstream depends on.
    CONSTRAINT chk_sep_approved_has_lwd
        CHECK (status NOT IN ('approved', 'completed') OR last_working_date IS NOT NULL),

    CONSTRAINT chk_sep_rejected_has_reason
        CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL),

    CONSTRAINT chk_sep_notice_days
        CHECK (notice_period_days >= 0 AND notice_shortfall_days >= 0)
);

-- One open case per employee. Without this, a double-submitted resignation or a
-- termination raised while a resignation is pending gives two live cases and
-- two final settlements for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_separation_open_per_employee
    ON employee_separations(employee_id)
    WHERE status IN ('pending', 'approved') AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_separations_company_status
    ON employee_separations(company_id, status)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_separations_employee
    ON employee_separations(employee_id, submitted_at DESC)
    WHERE deleted_at IS NULL;

-- The admin's "who is leaving this month" view.
CREATE INDEX IF NOT EXISTS idx_separations_lwd
    ON employee_separations(company_id, last_working_date)
    WHERE deleted_at IS NULL AND status = 'approved';


-- ------------------------------------------------------------
-- 2. FINAL SETTLEMENT
-- ------------------------------------------------------------
--
-- A SNAPSHOT, unlike the leave-salary balance and the gratuity accrual, which
-- are both derived on read. Once a settlement is agreed and paid it must not
-- move again — a salary correction entered next month cannot be allowed to
-- rewrite what was actually handed over. So every component is stored, together
-- with the inputs it was computed from.

CREATE TABLE IF NOT EXISTS employee_final_settlements (
    id                          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id                  UUID          NOT NULL REFERENCES companies(id)            ON DELETE CASCADE,
    employee_id                 UUID          NOT NULL REFERENCES employees(id)            ON DELETE CASCADE,
    separation_id               UUID          NOT NULL REFERENCES employee_separations(id) ON DELETE CASCADE,

    last_working_date           DATE          NOT NULL,

    -- Basis snapshot, so the arithmetic can be re-checked later
    calculation_base            VARCHAR(10)   NOT NULL DEFAULT 'basic',
    basis_amount                NUMERIC(12,2) NOT NULL DEFAULT 0,
    days_in_month               INTEGER       NOT NULL DEFAULT 30,
    daily_rate                  NUMERIC(12,4) NOT NULL DEFAULT 0,

    -- ── Earnings ────────────────────────────────────────────
    leave_encashment_days       NUMERIC(6,2)  NOT NULL DEFAULT 0,
    leave_encashment_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    gratuity_amount             NUMERIC(14,2) NOT NULL DEFAULT 0,
    -- Gratuity is a Gold feature. On a plan without it this stays 0 and
    -- gratuity_note explains why, rather than the settlement silently
    -- under-paying with no trace.
    gratuity_note               TEXT,
    pending_salary_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_earnings_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_earnings_note         TEXT,

    -- ── Deductions ──────────────────────────────────────────
    -- Notice not served: Art. 43 compensation in lieu.
    notice_shortfall_days       NUMERIC(6,2)  NOT NULL DEFAULT 0,
    notice_shortfall_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    advance_recovery_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_deductions_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_deductions_note       TEXT,

    total_earnings              NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_deductions            NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_settlement_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,

    currency                    VARCHAR(10),

    -- Everything the figures were derived from, kept verbatim for audit:
    -- the leave-salary balance, the gratuity breakdown, the config in force.
    calculation_snapshot        JSONB,

    status                      VARCHAR(20)   NOT NULL DEFAULT 'draft',
    approved_by                 UUID          REFERENCES users(id) ON DELETE SET NULL,
    approved_at                 TIMESTAMP,
    paid_at                     TIMESTAMP,
    payment_reference           VARCHAR(100),

    notes                       TEXT,
    created_by                  UUID          REFERENCES users(id) ON DELETE SET NULL,

    created_at                  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One settlement per case.
    CONSTRAINT uq_settlement_separation UNIQUE (separation_id),

    CONSTRAINT chk_settlement_status
        CHECK (status IN ('draft', 'approved', 'paid', 'cancelled')),
    CONSTRAINT chk_settlement_base
        CHECK (calculation_base IN ('basic', 'gross', 'custom')),
    CONSTRAINT chk_settlement_paid_consistency
        CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_settlements_company_status
    ON employee_final_settlements(company_id, status);

CREATE INDEX IF NOT EXISTS idx_settlements_employee
    ON employee_final_settlements(employee_id, last_working_date DESC);


-- ------------------------------------------------------------
-- 3. LINK ENCASHMENTS TO THE CASE
-- ------------------------------------------------------------
--
-- Added here rather than in 35 so each migration stands on its own in file
-- order. A final-settlement encashment is created BY the settlement, and this
-- column is what lets the bucket show why those days left it.

ALTER TABLE leave_salary_encashments
    ADD COLUMN IF NOT EXISTS separation_id UUID
        REFERENCES employee_separations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lsenc_separation
    ON leave_salary_encashments(separation_id)
    WHERE separation_id IS NOT NULL;


-- ------------------------------------------------------------
-- 4. updated_at triggers
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_separations_updated_at ON employee_separations;
CREATE TRIGGER trg_separations_updated_at
    BEFORE UPDATE ON employee_separations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_settlements_updated_at ON employee_final_settlements;
CREATE TRIGGER trg_settlements_updated_at
    BEFORE UPDATE ON employee_final_settlements
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 5. ENTITLEMENTS — catalog rows for this module
-- ============================================================

INSERT INTO plan_features (key, category, label, description, value_type, is_enforceable, is_visible, sort_order) VALUES
    ('offboarding.resignation',  'Offboarding',
     'Resignation workflow',
     'Employee-submitted resignation with notice period, approval and withdrawal.',
     'boolean', TRUE, TRUE, 1010),

    ('offboarding.termination',  'Offboarding',
     'Termination workflow',
     'Admin-initiated termination with cause, notice and gratuity-forfeiture decision.',
     'boolean', TRUE, TRUE, 1020),

    ('offboarding.settlement',   'Offboarding',
     'Final settlement statement',
     'Consolidated exit payout: leave encashment, gratuity, dues and deductions.',
     'boolean', TRUE, TRUE, 1030)
ON CONFLICT (key) DO UPDATE SET
    category       = EXCLUDED.category,
    label          = EXCLUDED.label,
    description    = EXCLUDED.description,
    value_type     = EXCLUDED.value_type,
    is_enforceable = EXCLUDED.is_enforceable,
    is_visible     = EXCLUDED.is_visible,
    sort_order     = EXCLUDED.sort_order;


-- ============================================================
-- 6. ENTITLEMENTS — Pro and Gold
-- ============================================================

WITH seed(plan_code, feature_key, bool_value, note) AS (
    VALUES
    ('trial', 'offboarding.resignation', FALSE, 'Available on Pro and Gold'),
    ('trial', 'offboarding.termination', FALSE, 'Available on Pro and Gold'),
    ('trial', 'offboarding.settlement',  FALSE, 'Available on Pro and Gold'),

    ('pro',   'offboarding.resignation', TRUE,  NULL),
    ('pro',   'offboarding.termination', TRUE,  NULL),
    ('pro',   'offboarding.settlement',  TRUE,  'Gratuity component requires Gold'),

    ('gold',  'offboarding.resignation', TRUE,  NULL),
    ('gold',  'offboarding.termination', TRUE,  NULL),
    ('gold',  'offboarding.settlement',  TRUE,  NULL)
)
INSERT INTO plan_feature_values (plan_id, feature_key, bool_value, note)
SELECT p.id, s.feature_key, s.bool_value, s.note
FROM seed s
JOIN plans p ON p.code = s.plan_code
ON CONFLICT (plan_id, feature_key) DO NOTHING;
