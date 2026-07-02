-- ============================================================
-- 20_payroll_daily_lines.sql
-- Must run after 16_payroll.sql
-- Frozen day-by-day snapshot for each payroll record.
-- Written once at generation time; breakdown reads from here
-- instead of recomputing attendance/leave/holiday state live.
-- ============================================================

CREATE TABLE IF NOT EXISTS payroll_daily_lines (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_id          UUID            NOT NULL REFERENCES payrolls(id) ON DELETE CASCADE,

    work_date           DATE            NOT NULL,
    day_of_week         VARCHAR(10)     NOT NULL,
    day_type            VARCHAR(30)     NOT NULL,

    per_day_salary       NUMERIC(12,4)   NOT NULL DEFAULT 0,
    pay_fraction         NUMERIC(4,2)    NOT NULL DEFAULT 0,
    deduct_fraction       NUMERIC(4,2)    NOT NULL DEFAULT 0,
    payable_amount        NUMERIC(12,2)   NOT NULL DEFAULT 0,
    deduction_amount      NUMERIC(12,2)   NOT NULL DEFAULT 0,
    overtime_hours        NUMERIC(6,2)    NOT NULL DEFAULT 0,
    overtime_amount       NUMERIC(12,2)   NOT NULL DEFAULT 0,
    net_day_amount        NUMERIC(12,2)   NOT NULL DEFAULT 0,

    total_hours          NUMERIC(6,2),
    is_sandwich          BOOLEAN         NOT NULL DEFAULT FALSE,

    created_at           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_payroll_daily_line UNIQUE (payroll_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_payroll_daily_lines_payroll_id
    ON payroll_daily_lines(payroll_id);