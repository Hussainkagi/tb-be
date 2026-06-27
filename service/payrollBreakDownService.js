const db = require("../config/database");

// ============================================================
// UTILITY — reused from payrollService (keep in sync)
// ============================================================

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

function calculateSandwichLeaves(allDates, deductDates, middleDates) {
    const sandwichDates = new Set();
    let i = 0;
    while (i < allDates.length) {
        const date = allDates[i];
        if (!middleDates.has(date)) { i++; continue; }
        const runStart = i;
        while (i < allDates.length && middleDates.has(allDates[i])) i++;
        const runEnd = i - 1;
        const beforeDate = runStart > 0 ? allDates[runStart - 1] : null;
        const afterDate = runEnd + 1 < allDates.length ? allDates[runEnd + 1] : null;
        if (beforeDate && deductDates.has(beforeDate) && afterDate && deductDates.has(afterDate)) {
            for (let j = runStart; j <= runEnd; j++) sandwichDates.add(allDates[j]);
        }
    }
    return sandwichDates;
}

// ============================================================
// DAY CLASSIFICATION CONSTANTS — readable labels
// ============================================================

const DAY_TYPE = {
    HOLIDAY: "holiday",          // company/public holiday — paid
    WEEK_OFF: "week_off",         // shift-level week off — paid
    COMP_OFF: "comp_off",         // comp-off (treated as non-deductible)
    PAID_LEAVE: "paid_leave",       // approved paid leave — no deduction
    HALF_DAY_LEAVE: "half_day_leave",   // approved half-day leave (paid)
    UNPAID_LEAVE: "unpaid_leave",     // approved unpaid leave — deducted
    PRESENT: "present",          // full day present
    HALF_DAY: "half_day",         // present < half_day_hours threshold
    ABSENT: "absent",           // no attendance record
    SANDWICH: "sandwich",         // middle day caught by sandwich rule
};

// ============================================================
// BREAKDOWN ENGINE — returns daily array for ONE employee
// ============================================================

async function buildDailyBreakdown(employee, period, shift, salaryStructure, attendanceMap, approvedLeaves, holidaySet) {
    const allDates = getDateRange(period.start_date, period.end_date);
    const totalDays = allDates.length;

    // ── Salary base ──────────────────────────────────────────
    const basicSalary = parseFloat(salaryStructure.actual_salary) || 0;
    const housingAllowance = parseFloat(salaryStructure.housing_allowance) || 0;
    const transportAllowance = parseFloat(salaryStructure.transport_allowance) || 0;
    const otherAllowance = parseFloat(salaryStructure.other_allowance) || 0;
    const grossSalary = basicSalary + housingAllowance + transportAllowance + otherAllowance;
    const perDaySalary = totalDays > 0 ? grossSalary / totalDays : 0;

    // ── Week-off day numbers ──────────────────────────────────
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const weekOffDayNumbers = new Set(
        [0, 1, 2, 3, 4, 5, 6].filter(d => !shift[dayNames[d]])
    );

    // ── Approved leave lookup ─────────────────────────────────
    const leaveDateMap = {};
    for (const leave of approvedLeaves) {
        const leaveDates = getDateRange(leave.from_date, leave.to_date);
        for (const d of leaveDates) {
            leaveDateMap[d] = { is_paid: leave.is_paid, is_half_day: leave.is_half_day };
        }
    }

    // ── PASS 1 — classify every date ────────────────────────────
    const deductDates = new Set();
    const middleDates = new Set();

    // Temporary store for classification before sandwich pass
    const rawClassification = {};

    for (const date of allDates) {
        const jsDate = new Date(date);
        const dayOfWeek = jsDate.getDay();
        const isWeekOff = weekOffDayNumbers.has(dayOfWeek);
        const isHoliday = holidaySet.has(date);
        const attendance = attendanceMap[date];
        const leaveInfo = leaveDateMap[date];

        // ── Holiday ──────────────────────────────────────────
        if (isHoliday) {
            middleDates.add(date);
            rawClassification[date] = { type: DAY_TYPE.HOLIDAY, payFraction: 1, deduct: false };
            continue;
        }

        // ── Week-off ─────────────────────────────────────────
        if (isWeekOff) {
            middleDates.add(date);
            rawClassification[date] = { type: DAY_TYPE.WEEK_OFF, payFraction: 1, deduct: false };
            continue;
        }

        // ── Approved Leave ────────────────────────────────────
        if (leaveInfo) {
            if (leaveInfo.is_paid) {
                const type = leaveInfo.is_half_day ? DAY_TYPE.HALF_DAY_LEAVE : DAY_TYPE.PAID_LEAVE;
                rawClassification[date] = { type, payFraction: leaveInfo.is_half_day ? 0.5 : 1, deduct: false };
            } else {
                const days = leaveInfo.is_half_day ? 0.5 : 1;
                rawClassification[date] = {
                    type: DAY_TYPE.UNPAID_LEAVE,
                    payFraction: 1 - days,   // 0 for full-day, 0.5 for half-day unpaid
                    deductFraction: days,
                    deduct: true,
                };
                deductDates.add(date);
            }
            continue;
        }

        // ── Attendance-based ──────────────────────────────────
        if (!attendance) {
            rawClassification[date] = { type: DAY_TYPE.ABSENT, payFraction: 0, deductFraction: 1, deduct: true };
            deductDates.add(date);
            continue;
        }

        const status = attendance.status;

        if (status === "checked-in" || status === "checked-out") {
            const totalHoursWorked = parseFloat(attendance.total_hours) || 0;
            const halfDayThreshold = parseFloat(shift.half_day_hours) || 0;

            if (halfDayThreshold > 0 && totalHoursWorked < halfDayThreshold) {
                // Half-day present → deduct 0.5
                rawClassification[date] = {
                    type: DAY_TYPE.HALF_DAY,
                    payFraction: 0.5,
                    deductFraction: 0.5,
                    deduct: true,
                    total_hours: totalHoursWorked,
                };
                deductDates.add(date);
            } else {
                // Full present
                let overtimeHours = 0;
                if (salaryStructure.overtime_enabled) {
                    const fullDayHours = parseFloat(shift.working_hours) || 8;
                    overtimeHours = Math.max(0, totalHoursWorked - fullDayHours);
                }
                rawClassification[date] = {
                    type: DAY_TYPE.PRESENT,
                    payFraction: 1,
                    deduct: false,
                    total_hours: totalHoursWorked,
                    overtime_hours: parseFloat(overtimeHours.toFixed(2)),
                };
            }
        } else if (status === "absent") {
            rawClassification[date] = { type: DAY_TYPE.ABSENT, payFraction: 0, deductFraction: 1, deduct: true };
            deductDates.add(date);
        } else if (status === "comp-off") {
            middleDates.add(date);
            rawClassification[date] = { type: DAY_TYPE.COMP_OFF, payFraction: 1, deduct: false };
        } else if (status === "leave") {
            // Leave without matching leave_request → absent
            rawClassification[date] = { type: DAY_TYPE.ABSENT, payFraction: 0, deductFraction: 1, deduct: true };
            deductDates.add(date);
        }
    }

    // ── PASS 2 — apply sandwich rule ─────────────────────────
    const sandwichDates = calculateSandwichLeaves(allDates, deductDates, middleDates);
    for (const d of sandwichDates) {
        if (!deductDates.has(d)) {
            deductDates.add(d);
            // Override the day's classification to sandwich
            rawClassification[d] = {
                ...rawClassification[d],
                type: DAY_TYPE.SANDWICH,
                payFraction: 0,
                deductFraction: 1,
                deduct: true,
            };
        }
    }

    // ── PASS 3 — build final daily rows ──────────────────────
    const overtimeRatePerHour = parseFloat(salaryStructure.overtime_rate_per_hour) || 0;

    const dailyRows = allDates.map(date => {
        const cls = rawClassification[date] || { type: "unknown", payFraction: 0, deduct: false };
        const jsDate = new Date(date);
        const dayOfWeek = dayNames[jsDate.getDay()];

        const deductFraction = cls.deductFraction || 0;
        const deductionAmt = parseFloat((perDaySalary * deductFraction).toFixed(2));
        const payableAmt = parseFloat((perDaySalary * cls.payFraction).toFixed(2));

        const overtimeHrs = cls.overtime_hours || 0;
        const overtimeAmt = parseFloat((overtimeHrs * overtimeRatePerHour).toFixed(2));

        return {
            date,
            day_of_week: dayOfWeek,
            day_type: cls.type,
            // --- monetary ---
            per_day_salary: parseFloat(perDaySalary.toFixed(4)),
            pay_fraction: cls.payFraction,
            deduct_fraction: deductFraction,
            payable_amount: payableAmt,
            deduction_amount: deductionAmt,
            overtime_hours: overtimeHrs,
            overtime_amount: overtimeAmt,
            net_day_amount: parseFloat((payableAmt + overtimeAmt).toFixed(2)),
            // --- attendance detail ---
            total_hours: cls.total_hours || null,
            is_sandwich: cls.type === DAY_TYPE.SANDWICH,
        };
    });

    // ── Summary totals (should match payrollService output) ──
    const summary = dailyRows.reduce((acc, row) => {
        acc.total_payable += row.payable_amount;
        acc.total_deduction += row.deduction_amount;
        acc.total_overtime_amt += row.overtime_amount;
        acc.total_overtime_hrs += row.overtime_hours;

        if (row.day_type === DAY_TYPE.PRESENT) acc.total_present++;
        else if (row.day_type === DAY_TYPE.HALF_DAY) acc.total_present += 0.5;
        else if (row.day_type === DAY_TYPE.ABSENT) acc.total_absent++;
        else if (row.day_type === DAY_TYPE.SANDWICH) acc.total_sandwich++;
        else if (row.day_type === DAY_TYPE.UNPAID_LEAVE) acc.total_unpaid_leave += row.deduct_fraction;
        else if ([DAY_TYPE.PAID_LEAVE, DAY_TYPE.HALF_DAY_LEAVE].includes(row.day_type))
            acc.total_paid_leave += row.pay_fraction;
        else if (row.day_type === DAY_TYPE.HOLIDAY) acc.total_holidays++;
        else if (row.day_type === DAY_TYPE.WEEK_OFF) acc.total_week_off++;
        else if (row.day_type === DAY_TYPE.COMP_OFF) acc.total_comp_off++;

        return acc;
    }, {
        total_payable: 0,
        total_deduction: 0,
        total_overtime_amt: 0,
        total_overtime_hrs: 0,
        total_present: 0,
        total_absent: 0,
        total_sandwich: 0,
        total_unpaid_leave: 0,
        total_paid_leave: 0,
        total_holidays: 0,
        total_week_off: 0,
        total_comp_off: 0,
    });

    // Round summary
    for (const key of Object.keys(summary)) {
        summary[key] = parseFloat(summary[key].toFixed(2));
    }

    summary.gross_salary = parseFloat(grossSalary.toFixed(2));
    summary.per_day_salary = parseFloat(perDaySalary.toFixed(4));
    summary.total_days = totalDays;
    summary.net_salary = parseFloat(
        (summary.gross_salary - summary.total_deduction + summary.total_overtime_amt).toFixed(2)
    );

    return { daily: dailyRows, summary };
}

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

// ============================================================
// Helper — build shift object from employee row
// ============================================================
function buildShift(row) {
    return {
        working_hours: row.working_hours || 8,
        half_day_hours: row.half_day_hours || 0,
        monday: row.monday ?? true,
        tuesday: row.tuesday ?? true,
        wednesday: row.wednesday ?? true,
        thursday: row.thursday ?? true,
        friday: row.friday ?? true,
        saturday: row.saturday ?? false,
        sunday: row.sunday ?? false,
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
            if (!payroll) {
                return { success: false, message: "Payroll record not found" };
            }

            const period = {
                start_date: payroll.start_date,
                end_date: payroll.end_date,
            };

            const salaryStructure = await fetchSalaryStructure(payroll.employee_id, period.start_date);
            if (!salaryStructure) {
                return { success: false, message: "No active salary structure found for this employee" };
            }

            const shift = buildShift(payroll);
            const branchId = payroll.emp_branch_id || payroll.branch_id;

            const [attendanceMap, holidaySet, approvedLeaves] = await Promise.all([
                fetchAttendanceForPeriod(payroll.employee_id, period.start_date, period.end_date),
                fetchHolidaysForPeriod(payroll.company_id, branchId, period.start_date, period.end_date),
                fetchApprovedLeaves(payroll.employee_id, period.start_date, period.end_date),
            ]);

            const breakdown = await buildDailyBreakdown(
                payroll, period, shift, salaryStructure, attendanceMap, approvedLeaves, holidaySet
            );

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
                        actual_salary: parseFloat(salaryStructure.actual_salary) || 0,
                        housing_allowance: parseFloat(salaryStructure.housing_allowance) || 0,
                        transport_allowance: parseFloat(salaryStructure.transport_allowance) || 0,
                        other_allowance: parseFloat(salaryStructure.other_allowance) || 0,
                        gross_salary: breakdown.summary.gross_salary,
                        per_day_salary: breakdown.summary.per_day_salary,
                    },
                    stored_payroll: {
                        gross_salary: parseFloat(payroll.gross_salary),
                        net_salary: parseFloat(payroll.net_salary),
                        payroll_status: payroll.payroll_status,
                    },
                    summary: breakdown.summary,
                    daily_breakdown: breakdown.daily,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Breakdown for ALL employees in a payroll period
    // ----------------------------------------------------------
    async getBreakdownByPeriod(company_id, payroll_period_id) {
        try {
            const payrolls = await fetchPayrollsByPeriod(company_id, payroll_period_id);
            if (!payrolls.length) {
                return { success: false, message: "No payroll records found for this period" };
            }

            const period = {
                start_date: payrolls[0].start_date,
                end_date: payrolls[0].end_date,
            };

            const results = await Promise.all(payrolls.map(async (payroll) => {
                try {
                    const salaryStructure = await fetchSalaryStructure(payroll.employee_id, period.start_date);
                    if (!salaryStructure) {
                        return {
                            employee_id: payroll.employee_id,
                            employee_code: payroll.employee_code,
                            name: `${payroll.first_name} ${payroll.last_name}`,
                            error: "No active salary structure found",
                        };
                    }

                    const shift = buildShift(payroll);
                    const branchId = payroll.emp_branch_id || payroll.branch_id;

                    const [attendanceMap, holidaySet, approvedLeaves] = await Promise.all([
                        fetchAttendanceForPeriod(payroll.employee_id, period.start_date, period.end_date),
                        fetchHolidaysForPeriod(company_id, branchId, period.start_date, period.end_date),
                        fetchApprovedLeaves(payroll.employee_id, period.start_date, period.end_date),
                    ]);

                    const breakdown = await buildDailyBreakdown(
                        payroll, period, shift, salaryStructure, attendanceMap, approvedLeaves, holidaySet
                    );

                    return {
                        payroll_id: payroll.id,
                        employee_id: payroll.employee_id,
                        employee_code: payroll.employee_code,
                        name: `${payroll.first_name} ${payroll.last_name}`,
                        payroll_status: payroll.payroll_status,
                        salary_info: {
                            gross_salary: breakdown.summary.gross_salary,
                            per_day_salary: breakdown.summary.per_day_salary,
                        },
                        summary: breakdown.summary,
                        daily_breakdown: breakdown.daily,
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
                        start_date: period.start_date,
                        end_date: period.end_date,
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