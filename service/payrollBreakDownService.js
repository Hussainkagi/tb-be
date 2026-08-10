const db = require("../config/database");
const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");
const PayrollDailyLineModel = require("../models/payrollDailyLineModel");
const PayrollSettingsModel = require("../models/payrollSettingsModel");
const { buildShift, buildDailyBreakdown, summarizeDailyRows, getDateRange } = require("./payrollEngineService");
const { computeFinalFigures } = require("./payrollService");
// ============================================================
// DB FETCHERS — minimal, scoped to what breakdown needs
// ============================================================

async function fetchPayrollById(payroll_id) {
    const result = await db.query(
        `SELECT
            p.*,
            e.first_name, e.last_name, e.employee_code,
            e.shift_id, e.branch_id AS emp_branch_id,
            e.joining_date::date::text AS joining_date,
            e.exit_date::date::text    AS exit_date,
            s.working_hours, s.half_day_hours,
            s.monday, s.tuesday, s.wednesday, s.thursday,
            s.friday, s.saturday, s.sunday,
            pp.period_name,
            pp.start_date::date::text AS start_date,   -- ← changed
            pp.end_date::date::text   AS end_date,     -- ← changed
            pp.status AS period_status
        FROM payrolls p
        JOIN employees e        ON p.employee_id = e.id
        LEFT JOIN shifts s      ON e.shift_id = s.id
        JOIN payroll_periods pp ON p.payroll_period_id = pp.id
        WHERE p.id = $1`,
        [payroll_id]
    );
    return result.rows[0] || null;
}

async function fetchPayrollsByPeriod(company_id, payroll_period_id) {
    const result = await db.query(
        `SELECT
            p.*,
            e.first_name, e.last_name, e.employee_code,
            e.shift_id, e.branch_id AS emp_branch_id,
            e.joining_date::date::text AS joining_date,
            e.exit_date::date::text    AS exit_date,
            s.working_hours, s.half_day_hours,
            s.monday, s.tuesday, s.wednesday, s.thursday,
            s.friday, s.saturday, s.sunday,
            pp.period_name, pp.start_date::date::text AS start_date, pp.end_date::date::text   AS end_date,
            pp.status AS period_status
         FROM payrolls p
         JOIN employees e        ON p.employee_id = e.id
         LEFT JOIN shifts s      ON e.shift_id = s.id
         JOIN payroll_periods pp ON p.payroll_period_id = pp.id
         WHERE p.company_id = $1 AND p.payroll_period_id = $2
         ORDER BY e.first_name ASC`,
        [company_id, payroll_period_id]
    );
    return result.rows;
}

async function fetchSalaryStructure(employee_id, periodStart) {
    const result = await db.query(
        `SELECT * FROM employee_salary_structures
         WHERE employee_id = $1
           AND is_active = TRUE
           AND effective_from <= $2
           AND (effective_to IS NULL OR effective_to >= $2)
         ORDER BY effective_from DESC
         LIMIT 1`,
        [employee_id, periodStart]
    );
    return result.rows[0] || null;
}

async function fetchAttendanceForPeriod(employee_id, startDate, endDate) {
    const result = await db.query(
        `SELECT attendance_date::text, status, total_hours
         FROM attendance
         WHERE employee_id = $1
           AND attendance_date BETWEEN $2 AND $3`,
        [employee_id, startDate, endDate]
    );
    const map = {};
    for (const row of result.rows) map[row.attendance_date] = row;
    return map;
}

async function fetchHolidaysForPeriod(company_id, branch_id, startDate, endDate) {
    const result = await db.query(
        `SELECT holiday_start_date, holiday_end_date
         FROM holidays
         WHERE company_id = $1
           AND is_active = TRUE
           AND deleted_at IS NULL
           AND holiday_start_date <= $3
           AND holiday_end_date   >= $2
           AND (is_company_wide = TRUE OR branch_id = $4)`,
        [company_id, startDate, endDate, branch_id]
    );
    const holidaySet = new Set();
    for (const row of result.rows) {
        getDateRange(row.holiday_start_date, row.holiday_end_date).forEach(d => holidaySet.add(d));
    }
    return holidaySet;
}

async function fetchApprovedLeaves(employee_id, startDate, endDate) {
    const result = await db.query(
        `SELECT lr.from_date, lr.to_date, lr.total_days, lr.is_half_day,
                lt.is_paid, lt.leave_name
         FROM leave_requests lr
         JOIN leave_types lt ON lr.leave_type_id = lt.id
         WHERE lr.employee_id = $1
           AND lr.status = 'approved'
           AND lr.deleted_at IS NULL
           AND lr.from_date <= $3
           AND lr.to_date   >= $2`,
        [employee_id, startDate, endDate]
    );
    return result.rows;
}

// ============================================================
// SUMMARY — aggregate persisted daily lines into totals.
//
// The aggregation itself lives in payrollEngineService so the numbers
// on this screen are produced by exactly the same code that produced
// the numbers at generation time. The old local copy had already
// drifted (it never counted sandwich days into unpaid leave).
// ============================================================

function summarizeFromLines(lines, payroll) {
    return summarizeDailyRows(lines, {
        grossSalary: parseFloat(payroll.gross_salary),
        basicSalary: parseFloat(payroll.actual_salary),
        perDaySalary: lines.length ? parseFloat(lines[0].per_day_salary) : 0,
    });
}

// ============================================================
// Layer manual adjustments (bonus/commission/deduction/penalty/loan)
// on top of an attendance-based summary.
// ============================================================

async function attachAdjustments(summary, payroll, payroll_id) {
    const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll_id);
    const figures = computeFinalFigures(payroll, adjustments);

    summary.adjustment_bonus = figures.adjustment_bonus;
    summary.adjustment_deduction = figures.adjustment_deduction;
    summary.total_bonus = figures.bonus_amount;
    summary.total_deduction_with_adjustments = figures.deduction_amount;
    summary.final_net_salary = figures.net_salary;
    // What is currently stored on the payroll row. If this ever differs from
    // final_net_salary the payroll needs recalculating — the UI can say so
    // instead of quietly showing two different totals on two screens.
    summary.stored_net_salary = parseFloat(payroll.net_salary);
    summary.is_stale = Math.abs(summary.stored_net_salary - figures.net_salary) > 0.01;

    return adjustments;
}

// ============================================================
// Snapshot loader — read persisted lines, or backfill once
// for legacy payrolls generated before this migration.
// ============================================================

async function getOrBackfillLines(payroll) {
    let lines = await PayrollDailyLineModel.findByPayrollId(payroll.id);
    if (lines.length > 0) return lines;

    // Legacy payroll generated before this migration — backfill once,
    // using attendance/leave/holiday state AS IT IS, best-effort.
    // After this, the snapshot becomes the permanent source of truth.
    const period = { start_date: payroll.start_date, end_date: payroll.end_date };
    const salaryStructure = await fetchSalaryStructure(payroll.employee_id, period.start_date);
    if (!salaryStructure) return [];

    const shift = buildShift(payroll);
    const branchId = payroll.emp_branch_id || payroll.branch_id;
    const [attendanceMap, holidaySet, approvedLeaves, settings] = await Promise.all([
        fetchAttendanceForPeriod(payroll.employee_id, period.start_date, period.end_date),
        fetchHolidaysForPeriod(payroll.company_id, branchId, period.start_date, period.end_date),
        fetchApprovedLeaves(payroll.employee_id, period.start_date, period.end_date),
        PayrollSettingsModel.getOrCreate(payroll.company_id),
    ]);

    const breakdown = buildDailyBreakdown({
        period,
        shift,
        salaryStructure,
        attendanceMap,
        approvedLeaves,
        holidaySet,
        employee: { joining_date: payroll.joining_date, exit_date: payroll.exit_date },
        settings,
    });

    lines = await PayrollDailyLineModel.bulkInsert(payroll.id, breakdown.daily);
    return lines;
}

function formatLineForResponse(l) {
    return {
        // work_date comes back from the model already cast to a YYYY-MM-DD
        // string. It used to be re-derived by zipping the rows against a
        // freshly generated date range — which silently mislabelled every
        // row if a single day was ever missing from the snapshot.
        date: l.work_date,
        day_of_week: l.day_of_week,
        day_type: l.day_type,
        per_day_salary: parseFloat(l.per_day_salary),
        pay_fraction: parseFloat(l.pay_fraction),
        deduct_fraction: parseFloat(l.deduct_fraction),
        payable_amount: parseFloat(l.payable_amount),
        deduction_amount: parseFloat(l.deduction_amount),
        overtime_hours: parseFloat(l.overtime_hours),
        overtime_amount: parseFloat(l.overtime_amount),
        net_day_amount: parseFloat(l.net_day_amount),
        total_hours: l.total_hours !== null && l.total_hours !== undefined ? parseFloat(l.total_hours) : null,
        attendance_status: l.attendance_status ?? null,
        is_sandwich: l.is_sandwich,
        remarks: l.remarks ?? null,
    };
}

function attachDates(lines) {
    return lines.map((l) => formatLineForResponse(l));
}


async function buildSalaryInfo(payroll, summary) {
    const salaryStructure = await fetchSalaryStructure(payroll.employee_id, payroll.start_date);
    return {
        actual_salary: parseFloat(salaryStructure?.actual_salary) || 0,
        housing_allowance: parseFloat(salaryStructure?.housing_allowance) || 0,
        transport_allowance: parseFloat(salaryStructure?.transport_allowance) || 0,
        other_allowance: parseFloat(salaryStructure?.other_allowance) || 0,
        gross_salary: summary.gross_salary,
        per_day_salary: summary.per_day_salary,
    };
}

// ============================================================
// MAIN SERVICE
// ============================================================

const PayrollBreakdownService = {

    // ----------------------------------------------------------
    // Breakdown for a single payroll record (by payroll ID)
    // ----------------------------------------------------------
    async getBreakdownByPayrollId(payroll_id) {
        try {
            const payroll = await fetchPayrollById(payroll_id);
            if (!payroll) return { success: false, message: "Payroll record not found" };

            const lines = await getOrBackfillLines(payroll);
            const summary = summarizeFromLines(lines, payroll);

            // Layer adjustments on top, same as getPayrollById, so this page's
            // net salary matches the list/grid view exactly.
            const adjustments = await attachAdjustments(summary, payroll, payroll_id);

            return {
                success: true,
                data: {
                    payroll_id,
                    employee: {
                        id: payroll.employee_id,
                        name: `${payroll.first_name} ${payroll.last_name}`,
                        employee_code: payroll.employee_code,
                    },
                    period: {
                        id: payroll.payroll_period_id,
                        period_name: payroll.period_name,
                        start_date: payroll.start_date,
                        end_date: payroll.end_date,
                        status: payroll.period_status,
                    },
                    salary_info: await buildSalaryInfo(payroll, summary),
                    stored_payroll: {
                        gross_salary: parseFloat(payroll.gross_salary),
                        net_salary: parseFloat(payroll.net_salary),
                        payroll_status: payroll.payroll_status,
                    },
                    adjustments,
                    summary,
                    daily_breakdown: attachDates(lines),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Repair the frozen day-by-day snapshot for one payroll.
    //
    // Needed because a snapshot can be wrong in ways regeneration cannot fix:
    //   • payrolls generated before the engine rewrite contain 'unknown' days
    //     that were neither paid nor deducted, so the rows do not add up to
    //     gross by a real amount
    //   • a paid or completed run is locked, so /generate refuses it — and
    //     rightly so, the money has already gone out
    //
    // This rebuilds ONLY the presentation snapshot from current attendance.
    // It never touches the stored payroll figures, so what was paid stays
    // what was paid; it reports any difference instead of silently applying it.
    // ----------------------------------------------------------
    async rebuildBreakdown(payroll_id) {
        try {
            const payroll = await fetchPayrollById(payroll_id);
            if (!payroll) return { success: false, message: "Payroll record not found" };

            const before = await PayrollDailyLineModel.findByPayrollId(payroll_id);
            const beforeTotal = before.reduce(
                (t, l) => t + parseFloat(l.payable_amount) + parseFloat(l.deduction_amount), 0
            );

            const period = { start_date: payroll.start_date, end_date: payroll.end_date };
            const salaryStructure = await fetchSalaryStructure(payroll.employee_id, period.start_date);
            if (!salaryStructure) {
                return { success: false, message: "No active salary structure — cannot rebuild the breakdown" };
            }

            const branchId = payroll.emp_branch_id || payroll.branch_id;
            const [attendanceMap, holidaySet, approvedLeaves, settings] = await Promise.all([
                fetchAttendanceForPeriod(payroll.employee_id, period.start_date, period.end_date),
                fetchHolidaysForPeriod(payroll.company_id, branchId, period.start_date, period.end_date),
                fetchApprovedLeaves(payroll.employee_id, period.start_date, period.end_date),
                PayrollSettingsModel.getOrCreate(payroll.company_id),
            ]);

            const breakdown = buildDailyBreakdown({
                period,
                shift: buildShift(payroll),
                salaryStructure,
                attendanceMap,
                approvedLeaves,
                holidaySet,
                employee: { joining_date: payroll.joining_date, exit_date: payroll.exit_date },
                settings,
            });

            const storedGross = parseFloat(payroll.gross_salary);
            const storedNet = parseFloat(payroll.net_salary);
            const rebuiltNet = breakdown.summary.net_salary;
            const rebuiltGross = breakdown.summary.gross_salary;

            // Refuse when the salary structure in force today differs from the one
            // the payroll was built on. Rebuilding then produces a breakdown for a
            // salary the employee was never paid — replacing one wrong snapshot
            // with a more convincing wrong snapshot. Report and stop.
            if (Math.abs(rebuiltGross - storedGross) > 0.005) {
                return {
                    success: false,
                    message:
                        `Salary structure has changed since this payroll was generated`
                        + ` (stored gross ${storedGross.toFixed(2)}, current structure gives ${rebuiltGross.toFixed(2)}).`
                        + ` Rebuilding would describe a salary that was never paid, so nothing was changed.`,
                    data: {
                        payroll_id,
                        stored_gross: storedGross,
                        recomputed_gross: rebuiltGross,
                        requires_manual_review: true,
                    },
                };
            }

            await PayrollDailyLineModel.deleteByPayrollId(payroll_id);
            const lines = await PayrollDailyLineModel.bulkInsert(payroll_id, breakdown.daily);

            return {
                success: true,
                message: `Breakdown rebuilt — ${lines.length} day(s)`,
                data: {
                    payroll_id,
                    days: lines.length,
                    before: {
                        line_total: parseFloat(beforeTotal.toFixed(2)),
                        matched_gross: Math.abs(beforeTotal - storedGross) < 0.005,
                    },
                    after: {
                        line_total: parseFloat(
                            (breakdown.summary.total_payable + breakdown.summary.total_deduction).toFixed(2)
                        ),
                        matched_gross:
                            Math.abs(breakdown.summary.total_payable + breakdown.summary.total_deduction - storedGross) < 0.005,
                    },
                    stored_net_salary: storedNet,
                    recomputed_net_salary: rebuiltNet,
                    // A non-zero difference means attendance or the salary structure
                    // changed since payday. Surfaced, never auto-applied — the paid
                    // amount is the authoritative one.
                    net_difference: parseFloat((rebuiltNet - storedNet).toFixed(2)),
                    payroll_status: payroll.payroll_status,
                    note: ["paid", "cancelled"].includes(payroll.payroll_status)
                        ? "This payroll is already settled — only the breakdown display was rebuilt."
                        : "Run POST /payrolls/:id/recalculate if the stored figures should follow.",
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Breakdown for ALL employees in a payroll period
    // Same snapshot-first pattern as getBreakdownByPayrollId,
    // applied per employee.
    // ----------------------------------------------------------
    async getBreakdownByPeriod(company_id, payroll_period_id) {
        try {
            const payrolls = await fetchPayrollsByPeriod(company_id, payroll_period_id);
            if (!payrolls.length) {
                return { success: false, message: "No payroll records found for this period" };
            }

            const results = await Promise.all(payrolls.map(async (payroll) => {
                try {
                    const lines = await getOrBackfillLines(payroll);
                    if (!lines.length) {
                        return {
                            employee_id: payroll.employee_id,
                            employee_code: payroll.employee_code,
                            name: `${payroll.first_name} ${payroll.last_name}`,
                            error: "No active salary structure found, or no daily lines could be generated",
                        };
                    }

                    const summary = summarizeFromLines(lines, payroll);
                    const adjustments = await attachAdjustments(summary, payroll, payroll.id);

                    return {
                        payroll_id: payroll.id,
                        employee_id: payroll.employee_id,
                        employee_code: payroll.employee_code,
                        name: `${payroll.first_name} ${payroll.last_name}`,
                        payroll_status: payroll.payroll_status,
                        salary_info: await buildSalaryInfo(payroll, summary),
                        stored_payroll: {
                            gross_salary: parseFloat(payroll.gross_salary),
                            net_salary: parseFloat(payroll.net_salary),
                            payroll_status: payroll.payroll_status,
                        },
                        adjustments,
                        summary,
                        daily_breakdown: attachDates(lines),
                    };
                } catch (empError) {
                    return {
                        payroll_id: payroll.id,
                        employee_id: payroll.employee_id,
                        employee_code: payroll.employee_code,
                        name: `${payroll.first_name} ${payroll.last_name}`,
                        error: empError.message,
                    };
                }
            }));

            const successful = results.filter(r => !r.error);
            const failed = results.filter(r => r.error);

            return {
                success: true,
                data: {
                    period: {
                        id: payroll_period_id,
                        period_name: payrolls[0].period_name,
                        start_date: payrolls[0].start_date,
                        end_date: payrolls[0].end_date,
                        status: payrolls[0].period_status,
                    },
                    total_employees: payrolls.length,
                    successful_count: successful.length,
                    failed_count: failed.length,
                    failed,
                    employees: successful,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PayrollBreakdownService;