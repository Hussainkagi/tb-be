const db = require("../config/database");
const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");
const PayrollDailyLineModel = require("../models/payrollDailyLineModel");
const { buildShift, buildDailyBreakdown } = require("./payrollEngineService");

// ============================================================
// DB FETCHERS — minimal, scoped to what breakdown needs
// ============================================================

async function fetchPayrollById(payroll_id) {
    const result = await db.query(
        `SELECT
            p.*,
            e.first_name, e.last_name, e.employee_code,
            e.shift_id, e.branch_id AS emp_branch_id,
            s.working_hours, s.half_day_hours,
            s.monday, s.tuesday, s.wednesday, s.thursday,
            s.friday, s.saturday, s.sunday,
            pp.period_name, pp.start_date, pp.end_date,
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
            s.working_hours, s.half_day_hours,
            s.monday, s.tuesday, s.wednesday, s.thursday,
            s.friday, s.saturday, s.sunday,
            pp.period_name, pp.start_date, pp.end_date,
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
                lt.is_paid
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

// Small local copy needed by fetchHolidaysForPeriod above.
// (Kept identical to the one inside payrollEngine.js.)
function getDateRange(start, end) {
    const dates = [];
    const current = new Date(start);
    const endDate = new Date(end);
    while (current <= endDate) {
        dates.push(current.toISOString().split("T")[0]);
        current.setDate(current.getDate() + 1);
    }
    return dates;
}

// ============================================================
// SUMMARY — aggregate persisted daily lines into totals
// ============================================================

function summarizeFromLines(lines, payroll) {
    const summary = lines.reduce((acc, row) => {
        acc.total_payable += parseFloat(row.payable_amount);
        acc.total_deduction += parseFloat(row.deduction_amount);
        acc.total_overtime_amt += parseFloat(row.overtime_amount);
        acc.total_overtime_hrs += parseFloat(row.overtime_hours);

        if (row.day_type === "present") acc.total_present++;
        else if (row.day_type === "half_day") acc.total_present += 0.5;
        else if (row.day_type === "absent") acc.total_absent++;
        else if (row.day_type === "sandwich") acc.total_sandwich++;
        else if (row.day_type === "unpaid_leave") acc.total_unpaid_leave += parseFloat(row.deduct_fraction);
        else if (["paid_leave", "half_day_leave"].includes(row.day_type)) acc.total_paid_leave += parseFloat(row.pay_fraction);
        else if (row.day_type === "holiday") acc.total_holidays++;
        else if (row.day_type === "week_off") acc.total_week_off++;
        else if (row.day_type === "comp_off") acc.total_comp_off++;

        return acc;
    }, {
        total_payable: 0, total_deduction: 0, total_overtime_amt: 0, total_overtime_hrs: 0,
        total_present: 0, total_absent: 0, total_sandwich: 0, total_unpaid_leave: 0,
        total_paid_leave: 0, total_holidays: 0, total_week_off: 0, total_comp_off: 0,
    });

    for (const key of Object.keys(summary)) summary[key] = parseFloat(summary[key].toFixed(2));

    summary.gross_salary = parseFloat(payroll.gross_salary);
    summary.per_day_salary = lines.length ? parseFloat(lines[0].per_day_salary) : 0;
    summary.total_days = lines.length;
    // Base net salary from attendance only — adjustments layered separately below
    summary.net_salary = parseFloat(
        (summary.gross_salary - summary.total_deduction + summary.total_overtime_amt).toFixed(2)
    );
    return summary;
}

// ============================================================
// Layer manual adjustments (bonus/commission/deduction/penalty/loan)
// on top of an attendance-based summary.
// ============================================================

async function attachAdjustments(summary, payroll, payroll_id) {
    const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll_id);
    let bonusTotal = 0, deductionTotal = 0;
    for (const adj of adjustments) {
        if (["deduction", "penalty", "loan"].includes(adj.adjustment_type)) deductionTotal += parseFloat(adj.amount);
        else if (["bonus", "commission"].includes(adj.adjustment_type)) bonusTotal += parseFloat(adj.amount);
    }
    summary.adjustment_bonus = parseFloat(bonusTotal.toFixed(2));
    summary.adjustment_deduction = parseFloat(deductionTotal.toFixed(2));
    summary.final_net_salary = parseFloat(payroll.net_salary); // stored, authoritative
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
    // using attendance/leave/holiday state AS IT WAS, best-effort.
    // After this, the snapshot becomes the permanent source of truth.
    const period = { start_date: payroll.start_date, end_date: payroll.end_date };
    const salaryStructure = await fetchSalaryStructure(payroll.employee_id, period.start_date);
    if (!salaryStructure) return [];

    const shift = buildShift(payroll);
    const branchId = payroll.emp_branch_id || payroll.branch_id;
    const [attendanceMap, holidaySet, approvedLeaves] = await Promise.all([
        fetchAttendanceForPeriod(payroll.employee_id, period.start_date, period.end_date),
        fetchHolidaysForPeriod(payroll.company_id, branchId, period.start_date, period.end_date),
        fetchApprovedLeaves(payroll.employee_id, period.start_date, period.end_date),
    ]);
    const breakdown = buildDailyBreakdown(period, shift, salaryStructure, attendanceMap, approvedLeaves, holidaySet);
    lines = await PayrollDailyLineModel.bulkInsert(payroll.id, breakdown.daily);
    return lines;
}

function formatLineForResponse(l) {
    return {
        date: l.date,
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
        total_hours: l.total_hours !== null ? parseFloat(l.total_hours) : null,
        is_sandwich: l.is_sandwich,
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
                    salary_info: {
                        gross_salary: summary.gross_salary,
                        per_day_salary: summary.per_day_salary,
                    },
                    stored_payroll: {
                        gross_salary: parseFloat(payroll.gross_salary),
                        net_salary: parseFloat(payroll.net_salary),
                        payroll_status: payroll.payroll_status,
                    },
                    adjustments,
                    summary,
                    daily_breakdown: lines.map(formatLineForResponse),
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
                        salary_info: {
                            gross_salary: summary.gross_salary,
                            per_day_salary: summary.per_day_salary,
                        },
                        stored_payroll: {
                            gross_salary: parseFloat(payroll.gross_salary),
                            net_salary: parseFloat(payroll.net_salary),
                            payroll_status: payroll.payroll_status,
                        },
                        adjustments,
                        summary,
                        daily_breakdown: lines.map(formatLineForResponse),
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