-- ============================================================
-- 44_payroll_period_off_cycle.sql
-- Must run after 15_payroll_period.sql
--
-- Records WHY a payroll period is not a whole month.
--
-- Periods are now created from a month + year, with the dates computed
-- server-side (payrollPeriodService.createPayrollPeriod). A partial range is
-- still allowed — final settlements need one — but only when the caller says
-- so explicitly. Without somewhere to store that intent, a two-day period
-- sitting in the table is indistinguishable from the accident this change
-- exists to prevent.
--
-- Existing rows are deliberately left FALSE, including any that are not whole
-- months. Those were mistakes rather than deliberate off-cycle runs, and
-- flagging them TRUE would hide exactly what needs reviewing:
--
--   SELECT id, period_name, start_date, end_date, (end_date - start_date + 1) AS days
--     FROM payroll_periods
--    WHERE is_off_cycle = FALSE
--      AND (start_date <> date_trunc('month', start_date)::date
--           OR end_date <> (date_trunc('month', start_date) + INTERVAL '1 month - 1 day')::date);
-- ============================================================

ALTER TABLE payroll_periods
    ADD COLUMN IF NOT EXISTS is_off_cycle BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN payroll_periods.is_off_cycle IS
    'TRUE when the period deliberately covers something other than a whole calendar month (final settlement, ad-hoc run).';
