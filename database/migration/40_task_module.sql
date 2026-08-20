-- ============================================================
-- 40_task_module.sql
-- Must run after:
--   01_company.sql, 02_branch.sql, 08_employee.sql,
--   32_department_head.sql, 34_plans_and_entitlements.sql
--
-- Tables:
--   1. task_categories      — per-company task buckets (Bug / Feature / ...)
--   2. tasks                — the work item itself
--   3. task_status_history  — append-only transition log (dashboard reads this)
--   4. task_comments        — free-form remarks, separate from transitions
--   5. task_watchers        — who gets notified besides the assignee
--
-- Why the module lives here and not in a service of its own: every rule it
-- enforces is a join away — the assignee is an employee, the HOD is
-- departments.head_employee_id, the reminder needs companies.timezone, and
-- the plan gate needs plan_feature_values. A separate service would have to
-- reach back into this database for all four.
-- ============================================================


-- ============================================================
-- 1. task_categories
--
-- Company-owned, unlike notification_templates there is no global row:
-- one company's "Operations" is not another's. Seeded per company on
-- demand (TaskCategoryService.seedDefaults) and backfilled below for
-- companies that already exist.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_categories (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id      UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    name            VARCHAR(100)    NOT NULL,
    description     TEXT,
    color_hex       VARCHAR(7),     -- '#RRGGBB', for the board UI

    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    deleted_at      TIMESTAMP,

    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Case-insensitive uniqueness: "Bug" and "bug" are the same bucket, and a
-- soft-deleted category must not block re-creating the name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_category_name_company
    ON task_categories (company_id, LOWER(name))
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_task_categories_company
    ON task_categories (company_id)
    WHERE deleted_at IS NULL;


-- ============================================================
-- 2. tasks
--
-- priority is a fixed CHECK list, NOT a company table. Criticality drives
-- SLA maths, list ordering and the performance weighting in
-- 42_task_performance.sql — all of which need a known, comparable set.
-- Companies can rename the labels in their UI; the stored keys stay put.
--
-- due_at is TIMESTAMPTZ while the rest of the schema uses TIMESTAMP. That
-- is deliberate: a deadline is an absolute instant that has to survive being
-- compared against employees in several countries. due_timezone keeps the
-- zone it was authored in so the app can render "5 PM Dubai" rather than a
-- converted time the person who set it would not recognise.
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
    id                          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relations
    company_id                  UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id                   UUID            REFERENCES branches(id) ON DELETE SET NULL,
    category_id                 UUID            REFERENCES task_categories(id) ON DELETE SET NULL,

    -- department_id is denormalized from the assignee at assignment time.
    -- HOD scoping and every dashboard grouping filter on it; carrying it here
    -- keeps those queries off a join to employees, and freezes the department
    -- the work was actually done for even if the person later transfers.
    department_id               UUID            REFERENCES departments(id) ON DELETE SET NULL,

    assigned_to_employee_id     UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    assigned_by_employee_id     UUID            REFERENCES employees(id) ON DELETE SET NULL,

    -- Content
    title                       VARCHAR(255)    NOT NULL,
    description                 TEXT,

    priority                    VARCHAR(20)     NOT NULL DEFAULT 'medium',
    status                      VARCHAR(20)     NOT NULL DEFAULT 'open',

    -- Deadline
    due_at                      TIMESTAMPTZ,
    due_timezone                VARCHAR(100),

    -- Lifecycle stamps, written by the status machine — never by the client
    started_at                  TIMESTAMP,
    submitted_at                TIMESTAMP,
    completed_at                TIMESTAMP,
    cancelled_at                TIMESTAMP,

    -- State
    deleted_at                  TIMESTAMP,

    -- Audit
    created_by_user_id          UUID            REFERENCES users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_task_priority
        CHECK (priority IN ('urgent', 'high', 'medium', 'low')),

    CONSTRAINT chk_task_status
        CHECK (status IN (
            'open',
            'in_progress',
            'submitted',
            'completed',
            'reopened',
            'cancelled'
        ))
);

-- "My tasks" — the single most-hit query in the module.
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_status
    ON tasks (company_id, assigned_to_employee_id, status)
    WHERE deleted_at IS NULL;

-- HOD board + department grouping on the performance dashboard.
CREATE INDEX IF NOT EXISTS idx_tasks_department_status
    ON tasks (company_id, department_id, status)
    WHERE deleted_at IS NULL;

-- Deadline sweep. Partial on live statuses only: the job never looks at
-- finished work, and completed rows are the bulk of the table over time.
CREATE INDEX IF NOT EXISTS idx_tasks_due_at_live
    ON tasks (due_at)
    WHERE deleted_at IS NULL
      AND due_at IS NOT NULL
      AND status IN ('open', 'in_progress', 'submitted', 'reopened');

CREATE INDEX IF NOT EXISTS idx_tasks_company_created
    ON tasks (company_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_category
    ON tasks (category_id)
    WHERE deleted_at IS NULL;


-- ============================================================
-- 3. task_status_history
--
-- Append-only. The performance rollup reads THIS, not tasks — a task row
-- only knows its current state, so "completed late twice after being
-- reopened" is invisible there. Never UPDATE or DELETE a row here.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_status_history (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    task_id             UUID            NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    from_status         VARCHAR(20),    -- NULL on the creation row
    to_status           VARCHAR(20)     NOT NULL,

    remark              TEXT,

    -- Who moved it, and in what capacity ('0' admin | '1' manager | '2' employee,
    -- matching user_companies.role). 'hod' is recorded as the acting role when
    -- a department head acts on someone else's task.
    changed_by_employee_id  UUID        REFERENCES employees(id) ON DELETE SET NULL,
    changed_by_role         VARCHAR(20),

    -- Was the deadline already past at the moment of this transition? Frozen
    -- here so the rollup never has to re-derive it against a due_at that an
    -- admin may have edited afterwards.
    was_overdue         BOOLEAN         NOT NULL DEFAULT FALSE,

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_history_task
    ON task_status_history (task_id, created_at);

-- Feeds the nightly rollup: one company's transitions for one day.
CREATE INDEX IF NOT EXISTS idx_task_history_company_created
    ON task_status_history (company_id, created_at);


-- ============================================================
-- 4. task_comments
--
-- Remarks that carry no state change. Kept out of task_status_history so
-- the history table stays a clean transition log for the dashboard.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_comments (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    task_id             UUID            NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    employee_id         UUID            REFERENCES employees(id) ON DELETE SET NULL,
    comment             TEXT            NOT NULL,

    deleted_at          TIMESTAMP,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task
    ON task_comments (task_id, created_at)
    WHERE deleted_at IS NULL;


-- ============================================================
-- 5. task_watchers
--
-- The assigner and the assignee's HOD are added automatically, so
-- "notify everyone who cares about this task" is one query and does not
-- re-derive the reporting line on every status change.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_watchers (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    task_id             UUID            NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    employee_id         UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_task_watcher UNIQUE (task_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_task_watchers_employee
    ON task_watchers (employee_id);


-- ============================================================
-- 6. SEED — default categories for every existing company
--
-- New companies get these from TaskCategoryService.seedDefaults; this
-- backfill is only for companies that predate the module.
-- ============================================================

INSERT INTO task_categories (company_id, name, description, color_hex)
SELECT c.id, d.name, d.description, d.color_hex
FROM companies c
CROSS JOIN (VALUES
    ('Bug',         'Something is broken and needs fixing',        '#E5484D'),
    ('Feature',     'New capability or enhancement',               '#3E63DD'),
    ('Operations',  'Day-to-day operational work',                 '#F5A524'),
    ('Support',     'Customer or internal support request',        '#12A594'),
    ('Documentation','Written material, reports and records',       '#8E4EC6'),
    ('Other',       'Anything that does not fit the buckets above', '#889096')
) AS d(name, description, color_hex)
WHERE c.deleted_at IS NULL
ON CONFLICT DO NOTHING;


-- ============================================================
-- 7. ENTITLEMENTS — feature keys + the plan grid
--
-- Mirrors enums/Task/... consumers via enums/features.js. A key added here
-- but not there (or the reverse) is the silent-denial trap documented at the
-- top of enums/features.js.
-- ============================================================

INSERT INTO plan_features (key, category, label, value_type, is_enforceable, is_visible, sort_order) VALUES
    ('tasks.manage',              'Tasks', 'Task assignment & tracking',               'boolean', TRUE, TRUE, 610),
    ('tasks.categories',          'Tasks', 'Custom task categories',                   'boolean', TRUE, TRUE, 620),
    ('notifications.task',        'Tasks', 'Task & deadline notifications',            'boolean', TRUE, TRUE, 630),
    ('reporting.task_performance','Tasks', 'Employee task performance dashboard',      'boolean', TRUE, TRUE, 640)
ON CONFLICT (key) DO NOTHING;

-- Trial gets the core loop so the module can be evaluated; the paid tiers get
-- the parts that only matter at scale (custom categories, the dashboard).
WITH seed(plan_code, feature_key, bool_value) AS (
    VALUES
    ('trial', 'tasks.manage',               TRUE),
    ('trial', 'tasks.categories',           FALSE),
    ('trial', 'notifications.task',         TRUE),
    ('trial', 'reporting.task_performance', FALSE),

    ('pro',   'tasks.manage',               TRUE),
    ('pro',   'tasks.categories',           TRUE),
    ('pro',   'notifications.task',         TRUE),
    ('pro',   'reporting.task_performance', TRUE),

    ('gold',  'tasks.manage',               TRUE),
    ('gold',  'tasks.categories',           TRUE),
    ('gold',  'notifications.task',         TRUE),
    ('gold',  'reporting.task_performance', TRUE)
)
INSERT INTO plan_feature_values (plan_id, feature_key, bool_value)
SELECT p.id, s.feature_key, s.bool_value
FROM seed s
JOIN plans p ON p.code = s.plan_code
ON CONFLICT (plan_id, feature_key) DO NOTHING;
