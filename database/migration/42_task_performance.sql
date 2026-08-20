-- ============================================================
-- 42_task_performance.sql
-- Must run after 40_task_module.sql
--
-- The read side of the task module.
--
-- The performance dashboard is NOT computed live over tasks +
-- task_status_history. Those tables grow without bound — a 200-person
-- company running a year of tasks is hundreds of thousands of transition
-- rows, and "average completion time per employee for the last quarter,
-- grouped by department" over that is a scan per page load.
--
-- Instead a nightly job (jobs/Task/taskPerformanceRollupJob.js) writes one
-- pre-aggregated row per employee per LOCAL day, and the dashboard reads a
-- table that stays small and indexed. Re-running the job for a day is safe:
-- the primary key makes it an upsert.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_performance_daily (
    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    employee_id             UUID            NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- The calendar day in the COMPANY's timezone, not UTC. Two employees
    -- finishing the same minute in Dubai and New York belong to the same
    -- company day, and a company's "yesterday" is what its admin expects
    -- the dashboard to show.
    stat_date               DATE            NOT NULL,

    -- Denormalized so the dashboard can group by department without joining
    -- employees, and so a later transfer does not rewrite history.
    department_id           UUID            REFERENCES departments(id) ON DELETE SET NULL,

    -- ── Counters ────────────────────────────────────────────────────────
    assigned_count          INTEGER         NOT NULL DEFAULT 0,
    completed_count         INTEGER         NOT NULL DEFAULT 0,
    completed_on_time       INTEGER         NOT NULL DEFAULT 0,
    completed_late          INTEGER         NOT NULL DEFAULT 0,
    reopened_count          INTEGER         NOT NULL DEFAULT 0,
    cancelled_count         INTEGER         NOT NULL DEFAULT 0,

    -- Snapshot at the moment the rollup ran, not a sum over the day
    open_at_eod             INTEGER         NOT NULL DEFAULT 0,
    overdue_at_eod          INTEGER         NOT NULL DEFAULT 0,

    -- ── Derived measures ────────────────────────────────────────────────
    -- Hours from task creation to completion, averaged over the tasks
    -- completed on this day. NULL when nothing was completed — 0 would
    -- read as "instant" on the chart.
    avg_completion_hours    NUMERIC(10, 2),

    -- Criticality-weighted score. Weights live in enums/Task/taskPerformance.js
    -- and are written into the row so a later weight change does not silently
    -- restate history.
    points_earned           NUMERIC(10, 2)  NOT NULL DEFAULT 0,

    computed_at             TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (company_id, employee_id, stat_date)
);

-- Company-wide leaderboard / trend for a date range.
CREATE INDEX IF NOT EXISTS idx_task_perf_company_date
    ON task_performance_daily (company_id, stat_date DESC);

-- HOD view: one department over a range.
CREATE INDEX IF NOT EXISTS idx_task_perf_department_date
    ON task_performance_daily (company_id, department_id, stat_date DESC);
