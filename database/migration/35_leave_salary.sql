-- ============================================================
-- 35_leave_salary.sql
-- Must run after 12_leave_type.sql, 13_leave_request.sql,
--               14_employee_salary_strucuture.sql,
--               34_plans_and_entitlements.sql
--
-- LEAVE SALARY — the annual-leave bucket.
--
-- Legal basis: UAE Federal Decree-Law 33/2021, Art. 29. 30 calendar days of
-- annual leave a year after one year of service, 2 days a month between 6 and
-- 12 months, nothing below 6 months. Leave salary is paid on the contractual
-- wage BEFORE the employee proceeds on leave, and unused balance is cashed out
-- when they leave. Spec: leave_salary_module.xlsx in the repo root.
--
-- The design mirrors how the rest of this codebase treats money:
--
--   * ACCRUAL IS A LEDGER, not a running total column. One row per employee per
--     month, each row snapshotting the rate and the basis salary it was booked
--     at. A single mutable balance column cannot answer "why does this employee
--     have 23.5 days" a year later, and it cannot be rebuilt after a bad import.
--
--   * THE BALANCE IS DERIVED — opening + accrued − taken − encashed. Days taken
--     come from the leave_requests the company already approves, so the bucket
--     can never disagree with the leave module about how much leave was used.
--
--   * VALUE IS REVALUED ON READ. The ledger stores the amount each month was
--     worth when booked (for reconciliation), but the payable figure is always
--     balance_days x TODAY's daily rate, because that is what Art. 29 entitles
--     the employee to. Storing the payable amount would go stale the moment a
--     salary changes — the same reason gratuity is never stored (see
--     27_employee_gratuity.sql).
--
-- Daily rate = chosen base / days_in_month (UAE convention: 30 calendar days,
-- not working days).
-- ============================================================


-- ------------------------------------------------------------
-- 1. WHICH LEAVE DRAWS DOWN THE BUCKET
-- ------------------------------------------------------------
--
-- Only annual leave consumes the accrued balance. Sick, maternity and unpaid
-- leave must not, or an employee returning from sick leave would silently lose
-- annual-leave days. This is a per-leave-type flag rather than a name match at
-- query time, because company leave types are free text ("Vacation", "Earned
-- Leave") and matching on the label would break the money maths quietly.

ALTER TABLE leave_types
    ADD COLUMN IF NOT EXISTS counts_toward_leave_salary BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN leave_types.counts_toward_leave_salary IS
    'TRUE for the annual-leave type(s) that draw down the accrued leave-salary bucket.';

-- Best-effort backfill for existing tenants: paid leave types that read as
-- annual leave. Anything ambiguous stays FALSE — under-counting is recoverable
-- from the panel, silently draining a balance is not.
UPDATE leave_types
SET counts_toward_leave_salary = TRUE
WHERE deleted_at IS NULL
  AND is_paid = TRUE
  AND counts_toward_leave_salary = FALSE
  AND (
        leave_name ILIKE '%annual%'
     OR leave_name ILIKE '%vacation%'
     OR leave_name ILIKE '%earned leave%'
  );


-- ------------------------------------------------------------
-- 2. COMPANY CONFIGURATION  (optional)
-- ------------------------------------------------------------
--
-- A row is OPTIONAL. With none, the statutory UAE defaults in
-- enums/leaveSalaryRules.js apply, so a company accrues correctly out of the
-- box — the same pattern as employee_gratuity_configs. A row exists only once
-- somebody overrides something.

CREATE TABLE IF NOT EXISTS leave_salary_configs (
    id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id                UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Daily-rate divisor. 30 = UAE calendar-day convention.
    days_in_month             INTEGER       NOT NULL DEFAULT 30,

    -- Art. 29 figures, editable because other jurisdictions differ.
    annual_entitlement_days   NUMERIC(5,2)  NOT NULL DEFAULT 30,
    accrual_rate_full         NUMERIC(5,2)  NOT NULL DEFAULT 2.5,   -- >= full_service_months
    accrual_rate_partial      NUMERIC(5,2)  NOT NULL DEFAULT 2,     -- min_service .. full_service
    min_service_months        INTEGER       NOT NULL DEFAULT 6,
    full_service_months       INTEGER       NOT NULL DEFAULT 12,

    -- Which salary figure the daily rate is built from, company-wide default.
    default_calculation_base  VARCHAR(10)   NOT NULL DEFAULT 'basic',

    -- Carry-forward ceiling on the bucket. NULL = uncapped.
    max_balance_days          NUMERIC(6,2),

    -- Master switches, so a company can run accrual without opening the
    -- payout paths (or the reverse, mid-migration from a legacy system).
    advance_payment_enabled   BOOLEAN       NOT NULL DEFAULT TRUE,
    encashment_enabled        BOOLEAN       NOT NULL DEFAULT TRUE,

    notes                     TEXT,

    created_at                TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at                TIMESTAMP,

    CONSTRAINT uq_leave_salary_config_company UNIQUE (company_id),

    CONSTRAINT chk_ls_config_days_in_month
        CHECK (days_in_month > 0 AND days_in_month <= 31),
    CONSTRAINT chk_ls_config_base
        CHECK (default_calculation_base IN ('basic', 'gross')),
    CONSTRAINT chk_ls_config_service_months
        CHECK (min_service_months >= 0 AND full_service_months >= min_service_months),
    CONSTRAINT chk_ls_config_rates
        CHECK (accrual_rate_full >= 0 AND accrual_rate_partial >= 0),
    CONSTRAINT chk_ls_config_max_balance
        CHECK (max_balance_days IS NULL OR max_balance_days >= 0)
);


-- ------------------------------------------------------------
-- 3. PER-EMPLOYEE OVERRIDES  (optional)
-- ------------------------------------------------------------
--
-- opening_balance_days is the reason this table is not optional in practice:
-- almost every company arrives mid-year with balances carried over from a
-- spreadsheet or a previous system. Without an opening balance the ledger would
-- have to be backdated to each employee's joining date to look right.

CREATE TABLE IF NOT EXISTS employee_leave_salary_configs (
    id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id                UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id               UUID          NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Turn accrual off for someone the scheme does not cover (consultants).
    is_enabled                BOOLEAN       NOT NULL DEFAULT TRUE,

    -- NULL = inherit the company default.
    calculation_base          VARCHAR(10),
    custom_basis_amount       NUMERIC(12,2),

    -- Overrides employees.joining_date when service started elsewhere.
    accrual_start_date        DATE,

    -- Balance brought in from outside the system, and the date it was true on.
    -- Accrual is only booked for months AFTER this date, so the two can never
    -- double-count.
    opening_balance_days      NUMERIC(6,2)  NOT NULL DEFAULT 0,
    opening_balance_as_of     DATE,

    notes                     TEXT,

    created_at                TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at                TIMESTAMP,

    CONSTRAINT uq_employee_leave_salary_config UNIQUE (employee_id),

    CONSTRAINT chk_els_base
        CHECK (calculation_base IS NULL OR calculation_base IN ('basic', 'gross', 'custom')),
    CONSTRAINT chk_els_custom_amount
        CHECK (calculation_base <> 'custom' OR custom_basis_amount IS NOT NULL),
    CONSTRAINT chk_els_opening_balance
        CHECK (opening_balance_days >= 0),
    -- An opening balance with no date cannot be positioned on the timeline, so
    -- accrual would not know which months to skip.
    CONSTRAINT chk_els_opening_needs_date
        CHECK (opening_balance_days = 0 OR opening_balance_as_of IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_els_configs_company
    ON employee_leave_salary_configs(company_id)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- 4. THE BUCKET — accrual ledger
-- ------------------------------------------------------------
--
-- One row per employee per accrued month. Booked by
-- POST /leave-salary/accruals/run (idempotent — re-running a month updates the
-- row in place rather than adding days twice).
--
-- Two fields exist purely to keep the first year honest:
--
--   is_deferred    months below the 6-month eligibility threshold. Booked at
--                  zero days rather than skipped, so the ledger shows a
--                  continuous timeline instead of an unexplained gap.
--   catch_up_days  the month eligibility is reached, the deferred months are
--                  credited here in one line. That is what makes an employee
--                  with 11 months of service hold 22 days (11 x 2) rather than
--                  10, which is the figure the spec sheet shows.

CREATE TABLE IF NOT EXISTS leave_salary_accruals (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id          UUID            NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    employee_id         UUID            NOT NULL REFERENCES employees(id)  ON DELETE CASCADE,

    -- The month being accrued
    period_year         INTEGER         NOT NULL,
    period_month        INTEGER         NOT NULL,
    period_end_date     DATE            NOT NULL,

    -- Why this many days
    service_months      NUMERIC(6,2)    NOT NULL DEFAULT 0,
    accrual_rate        NUMERIC(5,2)    NOT NULL DEFAULT 0,
    accrued_days        NUMERIC(6,2)    NOT NULL DEFAULT 0,   -- rate + catch_up_days
    catch_up_days       NUMERIC(6,2)    NOT NULL DEFAULT 0,
    is_deferred         BOOLEAN         NOT NULL DEFAULT FALSE,

    -- What those days were worth when booked. Snapshot, never recalculated:
    -- the payable figure is always derived from the CURRENT rate on read.
    calculation_base    VARCHAR(10)     NOT NULL DEFAULT 'basic',
    basis_amount        NUMERIC(12,2)   NOT NULL DEFAULT 0,
    days_in_month       INTEGER         NOT NULL DEFAULT 30,
    daily_rate          NUMERIC(12,4)   NOT NULL DEFAULT 0,
    accrued_amount      NUMERIC(14,2)   NOT NULL DEFAULT 0,

    note                TEXT,

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_leave_salary_accrual_period UNIQUE (employee_id, period_year, period_month),

    CONSTRAINT chk_lsa_month     CHECK (period_month BETWEEN 1 AND 12),
    CONSTRAINT chk_lsa_days      CHECK (accrued_days >= 0 AND catch_up_days >= 0),
    CONSTRAINT chk_lsa_base      CHECK (calculation_base IN ('basic', 'gross', 'custom'))
);

CREATE INDEX IF NOT EXISTS idx_lsa_company_period
    ON leave_salary_accruals(company_id, period_year, period_month);

CREATE INDEX IF NOT EXISTS idx_lsa_employee
    ON leave_salary_accruals(employee_id, period_end_date DESC);


-- ------------------------------------------------------------
-- 5. ADVANCE LEAVE SALARY
-- ------------------------------------------------------------
--
-- Art. 29: leave salary is paid BEFORE the employee proceeds on leave. This is
-- a payment-timing record, not a second draw on the bucket — the days
-- themselves are consumed by the approved leave_request. Linking to that
-- request is what keeps the two from being counted twice.
--
-- Two separate date concepts, deliberately not collapsed:
--   leave_from_date / leave_to_date  the leave being paid for
--   payroll_month                    the run this payment rides out on

CREATE TABLE IF NOT EXISTS leave_salary_advances (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id         UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- The approved annual leave this advance pays for. Nullable: some companies
    -- pay the advance before the request is filed in the system.
    leave_request_id    UUID            REFERENCES leave_requests(id) ON DELETE SET NULL,

    leave_from_date     DATE            NOT NULL,
    leave_to_date       DATE            NOT NULL,
    calendar_days       NUMERIC(6,2)    NOT NULL,

    -- Rate snapshot at the moment of payment — this one IS the money paid.
    calculation_base    VARCHAR(10)     NOT NULL DEFAULT 'basic',
    basis_amount        NUMERIC(12,2)   NOT NULL DEFAULT 0,
    days_in_month       INTEGER         NOT NULL DEFAULT 30,
    daily_rate          NUMERIC(12,4)   NOT NULL DEFAULT 0,
    amount              NUMERIC(14,2)   NOT NULL DEFAULT 0,

    payroll_month       VARCHAR(7),                            -- 'YYYY-MM'

    status              VARCHAR(20)     NOT NULL DEFAULT 'pending',
    approved_by         UUID            REFERENCES users(id) ON DELETE SET NULL,
    approved_at         TIMESTAMP,
    paid_at             TIMESTAMP,
    payment_reference   VARCHAR(100),
    cancelled_reason    TEXT,

    notes               TEXT,
    created_by          UUID            REFERENCES users(id) ON DELETE SET NULL,

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_lsadv_status
        CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
    CONSTRAINT chk_lsadv_dates
        CHECK (leave_to_date >= leave_from_date),
    CONSTRAINT chk_lsadv_days
        CHECK (calendar_days > 0),
    CONSTRAINT chk_lsadv_base
        CHECK (calculation_base IN ('basic', 'gross', 'custom')),
    CONSTRAINT chk_lsadv_payroll_month
        CHECK (payroll_month IS NULL OR payroll_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT chk_lsadv_paid_consistency
        CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

-- One live advance per leave request. Cancelled ones are excluded so a
-- mistaken advance can be cancelled and re-issued.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lsadv_leave_request_live
    ON leave_salary_advances(leave_request_id)
    WHERE leave_request_id IS NOT NULL AND status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_lsadv_company_status
    ON leave_salary_advances(company_id, status);

CREATE INDEX IF NOT EXISTS idx_lsadv_employee
    ON leave_salary_advances(employee_id, leave_from_date DESC);

CREATE INDEX IF NOT EXISTS idx_lsadv_payroll_month
    ON leave_salary_advances(company_id, payroll_month);


-- ------------------------------------------------------------
-- 6. ENCASHMENT
-- ------------------------------------------------------------
--
-- Unused balance paid out — normally on separation, occasionally in service.
-- Encashed days DO draw the bucket down: the employee took the money instead of
-- the leave.
--
-- separation_id is added by 36_employee_separation.sql rather than here, to
-- keep the migrations independently runnable in file order.

CREATE TABLE IF NOT EXISTS leave_salary_encashments (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id         UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    encashment_type     VARCHAR(20)     NOT NULL DEFAULT 'in_service',

    -- Last working date for a final settlement; the cut-off date otherwise.
    effective_date      DATE            NOT NULL,

    days_encashed       NUMERIC(6,2)    NOT NULL,

    calculation_base    VARCHAR(10)     NOT NULL DEFAULT 'basic',
    basis_amount        NUMERIC(12,2)   NOT NULL DEFAULT 0,
    days_in_month       INTEGER         NOT NULL DEFAULT 30,
    daily_rate          NUMERIC(12,4)   NOT NULL DEFAULT 0,
    amount              NUMERIC(14,2)   NOT NULL DEFAULT 0,

    payroll_month       VARCHAR(7),

    status              VARCHAR(20)     NOT NULL DEFAULT 'pending',
    approved_by         UUID            REFERENCES users(id) ON DELETE SET NULL,
    approved_at         TIMESTAMP,
    paid_at             TIMESTAMP,
    payment_reference   VARCHAR(100),
    cancelled_reason    TEXT,

    notes               TEXT,
    created_by          UUID            REFERENCES users(id) ON DELETE SET NULL,

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_lsenc_type
        CHECK (encashment_type IN ('final_settlement', 'in_service')),
    CONSTRAINT chk_lsenc_status
        CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
    CONSTRAINT chk_lsenc_days
        CHECK (days_encashed > 0),
    CONSTRAINT chk_lsenc_base
        CHECK (calculation_base IN ('basic', 'gross', 'custom')),
    CONSTRAINT chk_lsenc_payroll_month
        CHECK (payroll_month IS NULL OR payroll_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT chk_lsenc_paid_consistency
        CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_lsenc_company_status
    ON leave_salary_encashments(company_id, status);

CREATE INDEX IF NOT EXISTS idx_lsenc_employee
    ON leave_salary_encashments(employee_id, effective_date DESC);


-- ------------------------------------------------------------
-- 7. updated_at triggers
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_leave_salary_configs_updated_at ON leave_salary_configs;
CREATE TRIGGER trg_leave_salary_configs_updated_at
    BEFORE UPDATE ON leave_salary_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_els_configs_updated_at ON employee_leave_salary_configs;
CREATE TRIGGER trg_els_configs_updated_at
    BEFORE UPDATE ON employee_leave_salary_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_lsa_updated_at ON leave_salary_accruals;
CREATE TRIGGER trg_lsa_updated_at
    BEFORE UPDATE ON leave_salary_accruals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_lsadv_updated_at ON leave_salary_advances;
CREATE TRIGGER trg_lsadv_updated_at
    BEFORE UPDATE ON leave_salary_advances
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_lsenc_updated_at ON leave_salary_encashments;
CREATE TRIGGER trg_lsenc_updated_at
    BEFORE UPDATE ON leave_salary_encashments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 8. ENTITLEMENTS — catalog rows for this module
-- ============================================================
--
-- The module owns its feature keys (docs/PRICING_AND_PLANS.md §9). Keys must
-- match enums/features.js exactly or requireFeature() throws at boot.

INSERT INTO plan_features (key, category, label, description, value_type, is_enforceable, is_visible, sort_order) VALUES
    ('leave_salary.manage',        'Leave Salary',
     'Leave salary accrual & balance tracking',
     'Monthly accrual ledger, per-employee balance and the company-wide accrued liability.',
     'boolean', TRUE, TRUE, 910),

    ('leave_salary.advance_payment','Leave Salary',
     'Advance leave salary payment',
     'Pay leave salary before the employee proceeds on annual leave (UAE Art. 29).',
     'boolean', TRUE, TRUE, 920),

    ('leave_salary.encashment',    'Leave Salary',
     'Leave encashment / payout',
     'Cash out unused annual-leave balance, in service or on final settlement.',
     'boolean', TRUE, TRUE, 930)
ON CONFLICT (key) DO UPDATE SET
    category       = EXCLUDED.category,
    label          = EXCLUDED.label,
    description    = EXCLUDED.description,
    value_type     = EXCLUDED.value_type,
    is_enforceable = EXCLUDED.is_enforceable,
    is_visible     = EXCLUDED.is_visible,
    sort_order     = EXCLUDED.sort_order;


-- ============================================================
-- 9. ENTITLEMENTS — switch the module on for Pro and Gold
-- ============================================================
--
-- A new module normally ships off for every plan and is ticked in from the
-- Super Admin grid. This one is seeded on for Pro and Gold because the module
-- was commissioned as part of those plans; Trial gets an explicit FALSE row so
-- the pricing page can show it as a paid feature rather than omitting it.
--
-- DO NOTHING on conflict: after first run the panel owns the grid.

WITH seed(plan_code, feature_key, bool_value, note) AS (
    VALUES
    ('trial', 'leave_salary.manage',         FALSE, 'Available on Pro and Gold'),
    ('trial', 'leave_salary.advance_payment',FALSE, 'Available on Pro and Gold'),
    ('trial', 'leave_salary.encashment',     FALSE, 'Available on Pro and Gold'),

    ('pro',   'leave_salary.manage',         TRUE,  NULL),
    ('pro',   'leave_salary.advance_payment',TRUE,  NULL),
    ('pro',   'leave_salary.encashment',     TRUE,  NULL),

    ('gold',  'leave_salary.manage',         TRUE,  NULL),
    ('gold',  'leave_salary.advance_payment',TRUE,  NULL),
    ('gold',  'leave_salary.encashment',     TRUE,  NULL)
)
INSERT INTO plan_feature_values (plan_id, feature_key, bool_value, note)
SELECT p.id, s.feature_key, s.bool_value, s.note
FROM seed s
JOIN plans p ON p.code = s.plan_code
ON CONFLICT (plan_id, feature_key) DO NOTHING;
