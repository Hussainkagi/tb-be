-- ============================================================
-- HRMS Plans, Entitlements & Upgrade Coupons
-- ============================================================
--
-- Four layers, deliberately separated by who is allowed to change them:
--
--   1. plan_features           — the CATALOG of gateable things.
--                                Developer-owned, seeded by this migration.
--                                A key only belongs here once code enforces it.
--
--   2. plans                   — Trial / Pro / Gold. Super Admin CRUD.
--
--   3. plan_feature_values     — the GRID (plan × feature). Super Admin CRUD.
--                                This is what makes "add the Task module to
--                                Gold next month" a checkbox, not a deploy.
--
--   4. company_feature_overrides — per-company exceptions, so one negotiated
--                                deal never forces a duplicate plan.
--
-- Resolution order at runtime:  override → plan value → deny/zero.
--
-- Plus plan_coupons: the offline upgrade path (customer mails us → we take
-- payment → Super Admin mints a code bound to that company → company admin
-- redeems it in-app).
-- ============================================================


-- ------------------------------------------------------------
-- 1. FEATURE CATALOG  (developer-owned)
-- ------------------------------------------------------------
--
-- value_type drives how plan_feature_values is read AND how the frontend
-- renders the row in the Super Admin grid:
--
--   boolean → bool_value   (checkbox)          on / off
--   limit   → limit_value  (number input)      NULL = unlimited
--   enum    → json_value   (multi-select)      array of allowed sub-keys
--
-- is_enforceable = FALSE marks rows that exist only so the pricing page can
-- advertise them (support SLAs, onboarding). Nothing in code gates on them,
-- and requireFeature() refuses to accept such a key — that mistake is caught
-- at boot, not in production.

CREATE TABLE IF NOT EXISTS plan_features (
    key             VARCHAR(100)    PRIMARY KEY,
    category        VARCHAR(60)     NOT NULL,
    label           TEXT            NOT NULL,
    description     TEXT,
    value_type      VARCHAR(20)     NOT NULL DEFAULT 'boolean',
    is_enforceable  BOOLEAN         NOT NULL DEFAULT TRUE,
    is_visible      BOOLEAN         NOT NULL DEFAULT TRUE,   -- show on pricing page
    sort_order      INT             NOT NULL DEFAULT 0,

    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_plan_feature_value_type
        CHECK (value_type IN ('boolean', 'limit', 'enum'))
);

CREATE INDEX IF NOT EXISTS idx_plan_features_category
    ON plan_features(category, sort_order);


-- ------------------------------------------------------------
-- 2. PLANS  (Super Admin CRUD)
-- ------------------------------------------------------------
--
-- tier drives upgrade/downgrade comparison. A coupon may move a company to an
-- equal tier (renewal) or a higher one — never a lower one, so a leaked old
-- code cannot be used to strip an existing customer's plan.
--
-- is_fallback marks the single plan a company lands on when its paid plan
-- expires. Exactly one plan carries it (enforced by a partial unique index).

CREATE TABLE IF NOT EXISTS plans (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    code            VARCHAR(50)     NOT NULL UNIQUE,     -- trial | pro | gold
    name            VARCHAR(100)    NOT NULL,
    description     TEXT,
    tagline         TEXT,

    -- Commercials (display only — no payment is processed in-app)
    price_amount    NUMERIC(12,2)   NOT NULL DEFAULT 0,
    price_currency  VARCHAR(10)     NOT NULL DEFAULT 'USD',
    billing_period  VARCHAR(20)     NOT NULL DEFAULT 'monthly', -- monthly | yearly | once

    -- Lifecycle
    tier            INT             NOT NULL DEFAULT 0,   -- 0 trial, 10 pro, 20 gold
    duration_days   INT,                                  -- default subscription length; NULL = perpetual
    grace_days      INT             NOT NULL DEFAULT 3,   -- keep entitlements this long past expiry
    is_fallback     BOOLEAN         NOT NULL DEFAULT FALSE,
    is_public       BOOLEAN         NOT NULL DEFAULT TRUE, -- show on the in-app pricing page
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,

    sort_order      INT             NOT NULL DEFAULT 0,

    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP,

    CONSTRAINT chk_plans_billing_period
        CHECK (billing_period IN ('monthly', 'yearly', 'once')),
    CONSTRAINT chk_plans_grace_days
        CHECK (grace_days >= 0)
);

-- Only one fallback plan may exist at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_single_fallback
    ON plans((is_fallback))
    WHERE is_fallback = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plans_active
    ON plans(is_active, sort_order)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- 3. THE GRID: plan × feature  (Super Admin CRUD)
-- ------------------------------------------------------------
--
-- A missing row means DENIED, not "inherit". That is the whole point: a new
-- feature key ships switched off for every existing plan, and you turn it on
-- deliberately from the panel.
--
-- limit_value semantics:  NULL = unlimited,  0 = blocked,  n = cap of n.
-- Because NULL is meaningful, is_unlimited makes the intent explicit and
-- keeps "unlimited" distinguishable from "nobody filled this in".

CREATE TABLE IF NOT EXISTS plan_feature_values (
    plan_id         UUID            NOT NULL REFERENCES plans(id)         ON DELETE CASCADE,
    feature_key     VARCHAR(100)    NOT NULL REFERENCES plan_features(key) ON DELETE CASCADE,

    bool_value      BOOLEAN,
    limit_value     INT,
    is_unlimited    BOOLEAN         NOT NULL DEFAULT FALSE,
    json_value      JSONB,

    note            TEXT,                                   -- shown on the pricing page ("Trial: limited quota")

    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (plan_id, feature_key),

    CONSTRAINT chk_pfv_limit_non_negative
        CHECK (limit_value IS NULL OR limit_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pfv_feature
    ON plan_feature_values(feature_key);


-- ------------------------------------------------------------
-- 4. PER-COMPANY OVERRIDES
-- ------------------------------------------------------------
--
-- "Pro, but 150 employees." Without this you end up minting a private plan per
-- customer and the plan table rots within a year.
--
-- expires_at lets an override be temporary (a goodwill grant during a support
-- incident) and expire on its own instead of being forgotten.

CREATE TABLE IF NOT EXISTS company_feature_overrides (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id      UUID            NOT NULL REFERENCES companies(id)      ON DELETE CASCADE,
    feature_key     VARCHAR(100)    NOT NULL REFERENCES plan_features(key) ON DELETE CASCADE,

    bool_value      BOOLEAN,
    limit_value     INT,
    is_unlimited    BOOLEAN         NOT NULL DEFAULT FALSE,
    json_value      JSONB,

    reason          TEXT,
    expires_at      TIMESTAMP,                              -- NULL = permanent
    created_by      UUID            REFERENCES users(id)    ON DELETE SET NULL,

    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_company_feature_override UNIQUE (company_id, feature_key),
    CONSTRAINT chk_cfo_limit_non_negative
        CHECK (limit_value IS NULL OR limit_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cfo_company
    ON company_feature_overrides(company_id);


-- ------------------------------------------------------------
-- 5. UPGRADE COUPONS
-- ------------------------------------------------------------
--
-- Two independent time windows, which are easy to conflate and painful to
-- untangle later:
--
--   valid_from / valid_until  → when the code may be REDEEMED
--   duration_days             → how long the plan lasts ONCE redeemed
--
-- A code that must be used by 31 Jan and then grants 12 months needs both.
--
-- company_id is NOT NULL by design. We always know who paid before we mint a
-- code, so an unbound code is pure risk — anyone who sees it could claim it.

CREATE TABLE IF NOT EXISTS plan_coupons (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    code            VARCHAR(40)     NOT NULL UNIQUE,
    company_id      UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plan_id         UUID            NOT NULL REFERENCES plans(id)     ON DELETE RESTRICT,

    -- Redemption window
    valid_from      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    valid_until     TIMESTAMP       NOT NULL,

    -- What redeeming grants
    duration_days   INT,                                    -- NULL → falls back to plans.duration_days
    notes           TEXT,                                   -- invoice / payment reference

    -- State
    status          VARCHAR(20)     NOT NULL DEFAULT 'active', -- active | redeemed | revoked
    redeemed_at     TIMESTAMP,
    redeemed_by     UUID            REFERENCES users(id)    ON DELETE SET NULL,

    -- Snapshot of what the company was on before redeeming, so a mistaken
    -- upgrade can be reversed without guesswork.
    previous_plan_id        UUID    REFERENCES plans(id)    ON DELETE SET NULL,
    previous_expires_at     TIMESTAMP,

    revoked_at      TIMESTAMP,
    revoked_reason  TEXT,

    created_by      UUID            REFERENCES users(id)    ON DELETE SET NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_coupon_status
        CHECK (status IN ('active', 'redeemed', 'revoked')),
    CONSTRAINT chk_coupon_window
        CHECK (valid_until > valid_from),
    CONSTRAINT chk_coupon_duration
        CHECK (duration_days IS NULL OR duration_days > 0)
);

CREATE INDEX IF NOT EXISTS idx_plan_coupons_company
    ON plan_coupons(company_id, status);

CREATE INDEX IF NOT EXISTS idx_plan_coupons_code
    ON plan_coupons(code);

-- Redemption attempts — successes AND failures. A burst of failures against
-- one company is the signal that someone is guessing codes.
CREATE TABLE IF NOT EXISTS plan_coupon_attempts (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id      UUID            REFERENCES companies(id) ON DELETE CASCADE,
    user_id         UUID            REFERENCES users(id)     ON DELETE SET NULL,
    code_attempted  VARCHAR(40)     NOT NULL,
    was_successful  BOOLEAN         NOT NULL DEFAULT FALSE,
    failure_reason  VARCHAR(100),
    ip_address      VARCHAR(64),

    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_coupon_attempts_company
    ON plan_coupon_attempts(company_id, created_at DESC);


-- ------------------------------------------------------------
-- 6. COMPANIES → PLANS
-- ------------------------------------------------------------
--
-- companies.plan (VARCHAR) stays for now. It is still read by the Super Admin
-- company list filters, and dropping it in the same migration that introduces
-- plan_id would break those reads mid-deploy. It is kept in sync by
-- CompanyModel/SuperAdminModel writes and can be dropped once the console
-- filters move to plan_id.

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_companies_plan_id
    ON companies(plan_id)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- 7. updated_at triggers
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_plans_updated_at ON plans;
CREATE TRIGGER trg_plans_updated_at
    BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_plan_features_updated_at ON plan_features;
CREATE TRIGGER trg_plan_features_updated_at
    BEFORE UPDATE ON plan_features
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_pfv_updated_at ON plan_feature_values;
CREATE TRIGGER trg_pfv_updated_at
    BEFORE UPDATE ON plan_feature_values
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_cfo_updated_at ON company_feature_overrides;
CREATE TRIGGER trg_cfo_updated_at
    BEFORE UPDATE ON company_feature_overrides
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_plan_coupons_updated_at ON plan_coupons;
CREATE TRIGGER trg_plan_coupons_updated_at
    BEFORE UPDATE ON plan_coupons
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 8. SEED — feature catalog
-- ============================================================
--
-- Mirrors Ikration_teamBook_Pricing_Plans.xlsx. Labels and visibility are
-- editable afterwards from the panel; keys are not — code references them.
-- ON CONFLICT DO UPDATE so re-running the migration refreshes labels without
-- disturbing the grid.

INSERT INTO plan_features (key, category, label, value_type, is_enforceable, is_visible, sort_order) VALUES
    -- Access
    ('access.web_portal',            'Access',            'Web admin portal access',                        'boolean', TRUE,  TRUE,  10),
    ('access.mobile_app',            'Access',            'Mobile app (iOS & Android)',                     'boolean', TRUE,  TRUE,  20),
    ('limit.employees',              'Access',            'Number of employees included',                   'limit',   TRUE,  TRUE,  30),
    ('limit.branches',               'Access',            'Number of branches / locations',                 'limit',   TRUE,  TRUE,  40),
    ('access.role_based',            'Access',            'Role-based access (Admin / Manager / Employee)', 'boolean', TRUE,  TRUE,  50),
    ('access.company_settings',      'Access',            'Company profile & settings',                     'boolean', TRUE,  TRUE,  60),

    -- Attendance
    ('attendance.check_in_out',      'Attendance',        'Employee check-in / check-out',                  'boolean', TRUE,  TRUE, 110),
    ('attendance.gps_capture',       'Attendance',        'GPS location capture on check-in/out',           'boolean', TRUE,  TRUE, 120),
    ('attendance.photo_verification','Attendance',        'Photo Input on check-in/out',             'boolean', TRUE,  TRUE, 130),
    ('attendance.self_history',      'Attendance',        'Attendance history (employee self-view)',        'boolean', TRUE,  TRUE, 140),
    ('attendance.branch_map',        'Attendance',        'Branch attendance map view (admin)',             'boolean', TRUE,  TRUE, 150),
    ('limit.shifts',                 'Attendance',        'Shift management',                               'limit',   TRUE,  TRUE, 160),

    -- Leave & Holidays
    ('leave.workflow',               'Leave & Holidays',  'Leave application & approval workflow',          'boolean', TRUE,  TRUE, 210),
    ('leave.holiday_calendar',       'Leave & Holidays',  'Holiday calendar (admin managed)',               'boolean', TRUE,  TRUE, 220),
    ('leave.balance_policy_config',  'Leave & Holidays',  'Leave balance & policy configuration',           'boolean', TRUE,  TRUE, 230),
    ('leave.multi_level_approval',   'Leave & Holidays',  'Multi-level (HOD → Admin) approval',             'boolean', TRUE,  TRUE, 240),

    -- Notifications
    ('notifications.push',           'Notifications',     'Push notifications (check-in/out reminders)',     'boolean', TRUE,  TRUE, 310),
    ('notifications.leave_status',   'Notifications',     'Leave status notifications',                     'boolean', TRUE,  TRUE, 320),
    ('notifications.announcements',  'Notifications',     'Custom announcements',                           'boolean', TRUE,  TRUE, 330),

    -- Org Structure
    ('limit.departments',            'Org Structure',     'Department management',                          'limit',   TRUE,  TRUE, 410),

    -- Payroll & Gratuity
    ('payroll.generate',             'Payroll & Gratuity','Payroll generation & adjustment',                'boolean', TRUE,  TRUE, 510),
    ('payroll.payslip_pdf',          'Payroll & Gratuity','Payslip generation (PDF)',                       'boolean', TRUE,  TRUE, 520),
    ('gratuity.calculate',           'Payroll & Gratuity','Gratuity (end-of-service) calculation',          'boolean', TRUE,  TRUE, 530),
    ('gratuity.cross_border',        'Payroll & Gratuity','Cross-border gratuity & deviation tracking',     'boolean', TRUE,  TRUE, 540),
    ('gratuity.statutory_presets',   'Payroll & Gratuity','Statutory presets / tiered accrual config',      'boolean', TRUE,  TRUE, 550),

    -- Reporting
    ('reporting.dashboard',          'Reporting',         'Dashboard & attendance analytics (charts)',      'boolean', TRUE,  TRUE, 610),
    ('reporting.dashboard_alerts',   'Reporting',         'Dashboard errors & warnings panel',              'boolean', TRUE,  TRUE, 615),
    ('reporting.reports',            'Reporting',         'Custom reports & exports',                       'enum',    TRUE,  TRUE, 620),
    ('reporting.activity_log',       'Reporting',         'Activity logs / audit trail',                    'boolean', TRUE,  TRUE, 630),
    ('reporting.entity_history',     'Reporting',         'Advanced / entity-level audit history',          'boolean', TRUE,  TRUE, 640),

    -- Data & Storage
    ('data.image_storage',           'Data & Storage',    'Image storage',            'boolean', TRUE,  TRUE, 710),
    ('data.self_service_export',     'Data & Storage',    'Data export (self-service)',                     'boolean', TRUE,  TRUE, 720),
    ('data.extended_retention',      'Data & Storage',    'Extended data retention after cancellation',     'boolean', FALSE, TRUE, 730),

    -- Support & SLA — advertised on the pricing page, delivered by humans.
    -- is_enforceable = FALSE: no code path gates on these.
    ('support.email',                'Support & SLA',     'Email support',                                  'boolean', FALSE, TRUE, 810),
    ('support.priority',             'Support & SLA',     'Priority support',                               'boolean', FALSE, TRUE, 820),
    ('support.onboarding',           'Support & SLA',     'Dedicated onboarding assistance',                'boolean', FALSE, TRUE, 830),
    ('support.sla',                  'Support & SLA',     'Service-level agreement (uptime commitment)',     'boolean', FALSE, TRUE, 840)
ON CONFLICT (key) DO UPDATE SET
    category       = EXCLUDED.category,
    label          = EXCLUDED.label,
    value_type     = EXCLUDED.value_type,
    is_enforceable = EXCLUDED.is_enforceable,
    is_visible     = EXCLUDED.is_visible,
    sort_order     = EXCLUDED.sort_order;


-- ============================================================
-- 9. SEED — the three plans
-- ============================================================
--
-- DO NOTHING on conflict: once a plan exists, the panel owns it. Re-running
-- the migration must never overwrite pricing someone edited in production.

INSERT INTO plans (code, name, tagline, price_amount, price_currency, billing_period,
                   tier, duration_days, grace_days, is_fallback, is_public, sort_order, description) VALUES
    ('trial', 'Trial', 'Try teamBook free for 14 days',
     0, 'USD', 'once', 0, 14, 0, TRUE, TRUE, 10,
     'Everything you need to evaluate teamBook with a small team.'),

    ('pro',   'Pro',   'For growing teams that run payroll',
     0, 'USD', 'monthly', 10, 30, 3, FALSE, TRUE, 20,
     'Full attendance, payroll and reporting for up to 100 employees.'),

    ('gold',  'Gold',  'For multi-branch organisations',
     0, 'USD', 'monthly', 20, 30, 3, FALSE, TRUE, 30,
     'Unlimited scale, gratuity, advanced audit and priority support.')
ON CONFLICT (code) DO NOTHING;


-- ============================================================
-- 10. SEED — the grid
-- ============================================================
--
-- Straight from the spreadsheet. DO NOTHING on conflict for the same reason:
-- the panel is the source of truth after first run.

WITH seed(plan_code, feature_key, bool_value, limit_value, is_unlimited, json_value, note) AS (
    VALUES
    -- ── TRIAL ────────────────────────────────────────────────────────────
    ('trial', 'access.web_portal',             TRUE,  NULL,  FALSE, NULL::JSONB, NULL),
    ('trial', 'access.mobile_app',             TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'limit.employees',               NULL,  10,    FALSE, NULL,        'Up to 10 employees'),
    ('trial', 'limit.branches',                NULL,  1,     FALSE, NULL,        'Single location'),
    ('trial', 'access.role_based',             TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'access.company_settings',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'attendance.check_in_out',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'attendance.gps_capture',        TRUE,  NULL,  FALSE, NULL,        'Requires device permission'),
    ('trial', 'attendance.photo_verification', FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'attendance.self_history',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'attendance.branch_map',         FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'limit.shifts',                  NULL,  3,     FALSE, NULL,        'Up to 3 shifts'),
    ('trial', 'leave.workflow',                TRUE,  NULL,  FALSE, NULL,        'Single approval level'),
    ('trial', 'leave.holiday_calendar',        TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'leave.balance_policy_config',   FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'leave.multi_level_approval',    FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'notifications.push',            TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'notifications.leave_status',    TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'notifications.announcements',   FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'limit.departments',             NULL,  5,     FALSE, NULL,        'Up to 5 departments'),
    ('trial', 'payroll.generate',              FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'payroll.payslip_pdf',           FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'gratuity.calculate',            FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'gratuity.cross_border',         FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'gratuity.statutory_presets',    FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'reporting.dashboard',           TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'reporting.dashboard_alerts',    FALSE, NULL,  FALSE, NULL,        'Errors & warnings panel is Pro+'),
    ('trial', 'reporting.reports',             NULL,  NULL,  FALSE,
        '["casual","detailed"]'::JSONB, 'Casual + Attendance Detailed'),
    ('trial', 'reporting.activity_log',        FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'reporting.entity_history',      FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'data.image_storage',            TRUE,  NULL,  FALSE, NULL,        'Limited quota'),
    ('trial', 'data.self_service_export',      FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'data.extended_retention',       FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'support.email',                 TRUE,  NULL,  FALSE, NULL,        NULL),
    ('trial', 'support.priority',              FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'support.onboarding',            FALSE, NULL,  FALSE, NULL,        NULL),
    ('trial', 'support.sla',                   FALSE, NULL,  FALSE, NULL,        NULL),

    -- ── PRO ──────────────────────────────────────────────────────────────
    ('pro',   'access.web_portal',             TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'access.mobile_app',             TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'limit.employees',               NULL,  100,   FALSE, NULL,        'Up to 100 employees'),
    ('pro',   'limit.branches',                NULL,  5,     FALSE, NULL,        'Up to 5 branches'),
    ('pro',   'access.role_based',             TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'access.company_settings',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'attendance.check_in_out',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'attendance.gps_capture',        TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'attendance.photo_verification', TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'attendance.self_history',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'attendance.branch_map',         TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'limit.shifts',                  NULL,  100,   FALSE, NULL,        'Up to 100 shifts'),
    ('pro',   'leave.workflow',                TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'leave.holiday_calendar',        TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'leave.balance_policy_config',   TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'leave.multi_level_approval',    TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'notifications.push',            TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'notifications.leave_status',    TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'notifications.announcements',   TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'limit.departments',             NULL,  25,    FALSE, NULL,        'Up to 25 departments'),
    ('pro',   'payroll.generate',              TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'payroll.payslip_pdf',           TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'gratuity.calculate',            FALSE, NULL,  FALSE, NULL,        NULL),
    ('pro',   'gratuity.cross_border',         FALSE, NULL,  FALSE, NULL,        NULL),
    ('pro',   'gratuity.statutory_presets',    FALSE, NULL,  FALSE, NULL,        NULL),
    ('pro',   'reporting.dashboard',           TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'reporting.dashboard_alerts',    TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'reporting.reports',             NULL,  NULL,  FALSE,
        '["casual","detailed","working_hours","headcount"]'::JSONB, 'Trial reports + Working Hours + Headcount'),
    ('pro',   'reporting.activity_log',        TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'reporting.entity_history',      FALSE, NULL,  FALSE, NULL,        NULL),
    ('pro',   'data.image_storage',            TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'data.self_service_export',      TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'data.extended_retention',       FALSE, NULL,  FALSE, NULL,        NULL),
    ('pro',   'support.email',                 TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'support.priority',              FALSE, NULL,  FALSE, NULL,        NULL),
    ('pro',   'support.onboarding',            TRUE,  NULL,  FALSE, NULL,        NULL),
    ('pro',   'support.sla',                   TRUE,  NULL,  FALSE, NULL,        'Subject to signed SLA'),

    -- ── GOLD ─────────────────────────────────────────────────────────────
    ('gold',  'access.web_portal',             TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'access.mobile_app',             TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'limit.employees',               NULL,  NULL,  TRUE,  NULL,        'Unlimited'),
    ('gold',  'limit.branches',                NULL,  NULL,  TRUE,  NULL,        'Unlimited'),
    ('gold',  'access.role_based',             TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'access.company_settings',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'attendance.check_in_out',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'attendance.gps_capture',        TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'attendance.photo_verification', TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'attendance.self_history',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'attendance.branch_map',         TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'limit.shifts',                  NULL,  NULL,  TRUE,  NULL,        'Unlimited'),
    ('gold',  'leave.workflow',                TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'leave.holiday_calendar',        TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'leave.balance_policy_config',   TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'leave.multi_level_approval',    TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'notifications.push',            TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'notifications.leave_status',    TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'notifications.announcements',   TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'limit.departments',             NULL,  NULL,  TRUE,  NULL,        'Unlimited'),
    ('gold',  'payroll.generate',              TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'payroll.payslip_pdf',           TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'gratuity.calculate',            TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'gratuity.cross_border',         TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'gratuity.statutory_presets',    TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'reporting.dashboard',           TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'reporting.dashboard_alerts',    TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'reporting.reports',             NULL,  NULL,  FALSE,
        '["casual","detailed","working_hours","headcount","check_in_out_ratio","punctuality","payroll_breakdown"]'::JSONB,
        'All reports'),
    ('gold',  'reporting.activity_log',        TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'reporting.entity_history',      TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'data.image_storage',            TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'data.self_service_export',      TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'data.extended_retention',       TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'support.email',                 TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'support.priority',              TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'support.onboarding',            TRUE,  NULL,  FALSE, NULL,        NULL),
    ('gold',  'support.sla',                   TRUE,  NULL,  FALSE, NULL,        'Subject to signed SLA')
)
INSERT INTO plan_feature_values (plan_id, feature_key, bool_value, limit_value, is_unlimited, json_value, note)
SELECT p.id, s.feature_key, s.bool_value, s.limit_value, s.is_unlimited, s.json_value, s.note
FROM seed s
JOIN plans p ON p.code = s.plan_code
ON CONFLICT (plan_id, feature_key) DO NOTHING;


-- ============================================================
-- 11. BACKFILL — point existing companies at a plan row
-- ============================================================
--
-- Legacy companies.plan values map onto the new codes. Anything unrecognised
-- (or NULL) lands on the fallback plan rather than on no plan at all — a
-- company with plan_id IS NULL would otherwise resolve to "everything denied".

UPDATE companies c
SET plan_id = p.id
FROM plans p
WHERE c.plan_id IS NULL
  AND p.code = CASE
        WHEN c.plan IN ('gold', 'enterprise') THEN 'gold'
        WHEN c.plan IN ('pro', 'basic')       THEN 'pro'
        ELSE 'trial'
      END;

-- Trial companies that never got an expiry: date it from when they signed up.
UPDATE companies c
SET plan_expires_at = c.created_at + (p.duration_days || ' days')::INTERVAL
FROM plans p
WHERE c.plan_id = p.id
  AND c.plan_expires_at IS NULL
  AND p.duration_days IS NOT NULL;
