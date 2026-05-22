const db = require("../config/database");
const PayrollModel = require("../models/payrollModel");
const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");
const PayslipModel = require("../models/payslipModel");

// ============================================================
// UTILITY: Generate unique payslip number
// Format: PSL-{YYYYMM}-{employee_code}-{random4}
// ============================================================
function generatePayslipNumber(employee_code, periodStart) {
    const yyyymm = periodStart.toISOString().slice(0, 7).replace("-", "");
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `PSL-${yyyymm}-${employee_code}-${rand}`;
}

// ============================================================
// UTILITY: Get all calendar dates between two dates (inclusive)
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

// ============================================================
// UTILITY: Sandwich Leave Calculator
// Rule: if an absent/unpaid-leave day is both PRECEDED and FOLLOWED
//       by another absent/unpaid-leave (with only holidays/week-offs/
//       comp-offs in between), those middle non-working days are also
//       counted as deductible days.
//
// @param {string[]} allDates        - all calendar dates in the period
// @param {Set<string>} deductDates  - dates already marked for deduction
// @param {Set<string>} middleDates  - holiday / week-off / comp-off dates
// @returns {Set<string>}            - additional dates to deduct (sandwich days)
// ============================================================
function calculateSandwichLeaves(allDates, deductDates, middleDates) {
    const sandwichDates = new Set();

    // Walk through runs of consecutive "middle" dates
    let i = 0;
    while (i < allDates.length) {
        const date = allDates[i];

        if (!middleDates.has(date)) {
            i++;
            continue;
        }

        // Found start of a middle-day run — collect the entire run
        const runStart = i;
        while (i < allDates.length && middleDates.has(allDates[i])) {
            i++;
        }
        const runEnd = i - 1; // inclusive

        // Check the day BEFORE the run
        const beforeDate = runStart > 0 ? allDates[runStart - 1] : null;
        // Check the day AFTER the run
        const afterDate = runEnd + 1 < allDates.length ? allDates[runEnd + 1] : null;

        const beforeIsDeductible = beforeDate && deductDates.has(beforeDate);
        const afterIsDeductible = afterDate && deductDates.has(afterDate);

        if (beforeIsDeductible && afterIsDeductible) {
            for (let j = runStart; j <= runEnd; j++) {
                sandwichDates.add(allDates[j]);
            }
        }
    }

    return sandwichDates;
}

// ============================================================
// CORE ENGINE: Calculate payroll for a single employee
// ============================================================
async function calculateEmployeePayroll(employee, period, shift, salaryStructure, attendanceMap, approvedLeaves, holidaySet) {
    const allDates = getDateRange(period.start_date, period.end_date);
    const totalWorkingDays = allDates.length;

    // ----------------------------------------------------------
    // STEP 1 — SALARY STRUCTURE
    // ----------------------------------------------------------
    const basicSalary = parseFloat(salaryStructure.basic_salary) || 0;
    const housingAllowance = parseFloat(salaryStructure.housing_allowance) || 0;
    const transportAllowance = parseFloat(salaryStructure.transport_allowance) || 0;
    const otherAllowance = parseFloat(salaryStructure.other_allowance) || 0;
    const grossSalary = basicSalary + housingAllowance + transportAllowance + otherAllowance;
    const perDaySalary = totalWorkingDays > 0 ? grossSalary / totalWorkingDays : 0;

    // ----------------------------------------------------------
    // STEP 2 — BUILD SHIFT WEEK-OFF SET
    //   shift stores monday…sunday booleans (true = working day)
    //   week-off = day NOT in working days
    // ----------------------------------------------------------
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const weekOffDayNumbers = new Set(
        [0, 1, 2, 3, 4, 5, 6].filter((d) => !shift[dayNames[d]])
    );

    // ----------------------------------------------------------
    // STEP 3 — BUILD APPROVED LEAVE LOOKUP
    //   leave maps: date → { is_paid, is_half_day }
    // ----------------------------------------------------------
    const leaveDateMap = {};
    for (const leave of approvedLeaves) {
        const leaveDates = getDateRange(leave.from_date, leave.to_date);
        for (const d of leaveDates) {
            leaveDateMap[d] = {
                is_paid: leave.is_paid,
                is_half_day: leave.is_half_day,
            };
        }
    }

    // ----------------------------------------------------------
    // STEP 4 — CLASSIFY EACH DATE
    // ----------------------------------------------------------
    let totalPresentDays = 0;
    let totalAbsentDays = 0;
    let totalPaidLeaveDays = 0;
    let totalUnpaidLeaveDays = 0;
    let totalHolidays = 0;
    let overtimeHours = 0;

    const deductDates = new Set();  // dates that incur salary deduction
    const middleDates = new Set();  // holiday / week-off / comp-off dates (potential sandwich)

    for (const date of allDates) {
        const jsDate = new Date(date);
        const dayOfWeek = jsDate.getDay(); // 0=Sun…6=Sat
        const isWeekOff = weekOffDayNumbers.has(dayOfWeek);
        const isHoliday = holidaySet.has(date);
        const attendance = attendanceMap[date];
        const leaveInfo = leaveDateMap[date];

        // ── Holiday ──────────────────────────────────────────
        if (isHoliday) {
            totalHolidays++;
            middleDates.add(date);
            continue;
        }

        // ── Week-off ─────────────────────────────────────────
        if (isWeekOff) {
            middleDates.add(date);
            continue;
        }

        // ── Approved Leave ────────────────────────────────────
        if (leaveInfo) {
            if (leaveInfo.is_paid) {
                totalPaidLeaveDays += leaveInfo.is_half_day ? 0.5 : 1;
                // paid leave → no deduction, counts as present
                totalPresentDays += leaveInfo.is_half_day ? 0.5 : 1;
            } else {
                const days = leaveInfo.is_half_day ? 0.5 : 1;
                totalUnpaidLeaveDays += days;
                deductDates.add(date);
            }
            continue;
        }

        // ── Attendance-based ──────────────────────────────────
        if (!attendance) {
            // No attendance record → absent
            totalAbsentDays++;
            deductDates.add(date);
            continue;
        }

        const status = attendance.status;

        if (status === "checked-in" || status === "checked-out") {
            const totalHoursWorked = parseFloat(attendance.total_hours) || 0;
            const halfDayThreshold = parseFloat(shift.half_day_hours) || 0;

            if (halfDayThreshold > 0 && totalHoursWorked < halfDayThreshold) {
                // Half day
                totalPresentDays += 0.5;
                deductDates.add(date); // deduct half day
            } else {
                totalPresentDays++;
            }

            // Overtime
            if (salaryStructure.overtime_enabled) {
                const fullDayHours = parseFloat(shift.working_hours) || 8;
                const ot = Math.max(0, totalHoursWorked - fullDayHours);
                overtimeHours += ot;
            }
        } else if (status === "absent") {
            totalAbsentDays++;
            deductDates.add(date);
        } else if (status === "comp-off") {
            middleDates.add(date);
        } else if (status === "leave") {
            // Leave status without a matching leave_request → treat as unpaid absent
            totalAbsentDays++;
            deductDates.add(date);
        }
        // holiday / week-off on attendance record — already handled above
    }

    // ----------------------------------------------------------
    // STEP 5 — SANDWICH LEAVE
    // ----------------------------------------------------------
    const sandwichDates = calculateSandwichLeaves(allDates, deductDates, middleDates);
    for (const d of sandwichDates) {
        if (!deductDates.has(d)) {
            deductDates.add(d);
            totalUnpaidLeaveDays += 1; // sandwich days are effectively unpaid deductions
        }
    }

    // ----------------------------------------------------------
    // STEP 6 — DEDUCTION
    // ----------------------------------------------------------
    // Half-day deductions: a date in deductDates where totalPresentDays was +0.5
    // We deduct exactly 0.5 per-day salary for half days captured above.
    // For full deduct dates the full per_day_salary is deducted.
    // We track precise deduction by summing per-type deductions.

    let deductionDays = 0;
    for (const date of deductDates) {
        const leaveInfo = leaveDateMap[date];
        if (leaveInfo && leaveInfo.is_half_day) {
            deductionDays += 0.5;
        } else {
            deductionDays += 1;
        }
    }

    const deductionAmount = parseFloat((perDaySalary * deductionDays).toFixed(2));

    // ----------------------------------------------------------
    // STEP 7 — OVERTIME AMOUNT
    // ----------------------------------------------------------
    const overtimeRatePerHour = parseFloat(salaryStructure.overtime_rate_per_hour) || 0;
    const overtimeAmount = parseFloat((overtimeHours * overtimeRatePerHour).toFixed(2));

    // ----------------------------------------------------------
    // STEP 8 — NET SALARY
    // ----------------------------------------------------------
    const netSalary = parseFloat(
        (grossSalary - deductionAmount + overtimeAmount).toFixed(2)
    );

    return {
        basic_salary: basicSalary,
        gross_salary: parseFloat(grossSalary.toFixed(2)),
        total_working_days: totalWorkingDays,
        total_present_days: parseFloat(totalPresentDays.toFixed(2)),
        total_absent_days: totalAbsentDays,
        total_paid_leave_days: parseFloat(totalPaidLeaveDays.toFixed(2)),
        total_unpaid_leave_days: parseFloat(totalUnpaidLeaveDays.toFixed(2)),
        total_holidays: totalHolidays,
        overtime_hours: parseFloat(overtimeHours.toFixed(2)),
        overtime_amount: overtimeAmount,
        deduction_amount: deductionAmount,
        net_salary: netSalary,
    };
}

// ============================================================
// DATA FETCHERS — isolated DB queries used by the engine
// ============================================================

async function fetchPayrollPeriod(payroll_period_id) {
    const result = await db.query(
        `SELECT * FROM payroll_periods WHERE id = $1`,
        [payroll_period_id]
    );
    return result.rows[0] || null;
}

async function fetchActiveEmployees(company_id, branch_id = null) {
    const params = [company_id];
    let branchClause = "";
    if (branch_id) {
        params.push(branch_id);
        branchClause = `AND e.branch_id = $2`;
    }
    const result = await db.query(
        `SELECT e.*, s.shift_name, s.working_hours, s.half_day_hours,
                s.monday, s.tuesday, s.wednesday, s.thursday,
                s.friday, s.saturday, s.sunday
         FROM employees e
         LEFT JOIN shifts s ON e.shift_id = s.id
         WHERE e.company_id = $1
           AND e.status = 'active'
           AND e.is_active = TRUE
           AND e.deleted_at IS NULL
           ${branchClause}`,
        params
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
    // Return as a date-keyed map for O(1) lookup
    const map = {};
    for (const row of result.rows) {
        map[row.attendance_date] = row;
    }
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

    // Expand multi-day holidays into individual date strings
    const holidaySet = new Set();
    for (const row of result.rows) {
        const dates = getDateRange(row.holiday_start_date, row.holiday_end_date);
        dates.forEach((d) => holidaySet.add(d));
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
// MAIN SERVICE
// ============================================================
const PayrollService = {

    // ----------------------------------------------------------
    // Generate payroll for a single branch OR entire company
    // ----------------------------------------------------------
    async generatePayroll(data) {
        const { company_id, payroll_period_id, branch_id = null } = data;
        const generated = [];
        const skipped = [];
        const errors = [];

        try {
            // ── STEP 1: Fetch payroll period ──────────────────
            const period = await fetchPayrollPeriod(payroll_period_id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }
            if (period.company_id !== company_id) {
                return { success: false, message: "Payroll period does not belong to this company" };
            }
            if (period.status === "locked") {
                return { success: false, message: "Payroll period is locked and cannot be processed" };
            }

            // ── STEP 2: Fetch active employees ────────────────
            const employees = await fetchActiveEmployees(company_id, branch_id);
            if (employees.length === 0) {
                return { success: false, message: "No active employees found" };
            }

            // ── Mark period as processing ─────────────────────
            await db.query(
                `UPDATE payroll_periods SET status = 'processing' WHERE id = $1`,
                [payroll_period_id]
            );

            // ── STEP 3-8: Process each employee ───────────────
            for (const employee of employees) {
                try {
                    // Skip if payroll already exists for this employee/period
                    const existing = await PayrollModel.findByEmployeeAndPeriod(
                        employee.id,
                        payroll_period_id
                    );
                    if (existing) {
                        skipped.push({
                            employee_id: employee.id,
                            reason: "Payroll already exists",
                        });
                        continue;
                    }

                    // Fetch salary structure
                    const salaryStructure = await fetchSalaryStructure(
                        employee.id,
                        period.start_date
                    );
                    if (!salaryStructure) {
                        skipped.push({
                            employee_id: employee.id,
                            employee_code: employee.employee_code,
                            reason: "No active salary structure found",
                        });
                        continue;
                    }

                    // Shift — embedded in employee row from JOIN
                    const shift = {
                        working_hours: employee.working_hours || 8,
                        half_day_hours: employee.half_day_hours || 0,
                        monday: employee.monday ?? true,
                        tuesday: employee.tuesday ?? true,
                        wednesday: employee.wednesday ?? true,
                        thursday: employee.thursday ?? true,
                        friday: employee.friday ?? true,
                        saturday: employee.saturday ?? false,
                        sunday: employee.sunday ?? false,
                    };

                    const empBranchId = employee.branch_id;

                    // Fetch attendance, holidays, leaves in parallel
                    const [attendanceMap, holidaySet, approvedLeaves] = await Promise.all([
                        fetchAttendanceForPeriod(employee.id, period.start_date, period.end_date),
                        fetchHolidaysForPeriod(company_id, empBranchId, period.start_date, period.end_date),
                        fetchApprovedLeaves(employee.id, period.start_date, period.end_date),
                    ]);

                    // Calculate payroll figures
                    const calc = await calculateEmployeePayroll(
                        employee,
                        period,
                        shift,
                        salaryStructure,
                        attendanceMap,
                        approvedLeaves,
                        holidaySet
                    );

                    // Create payroll record
                    const payroll = await PayrollModel.create({
                        company_id,
                        payroll_period_id,
                        employee_id: employee.id,
                        branch_id: empBranchId,
                        ...calc,
                        bonus_amount: 0,
                        tax_amount: 0,
                        payroll_status: "processed",
                    });

                    generated.push(payroll);
                } catch (empError) {
                    errors.push({
                        employee_id: employee.id,
                        employee_code: employee.employee_code,
                        error: empError.message,
                    });
                }
            }

            // ── Mark period as completed ──────────────────────
            await db.query(
                `UPDATE payroll_periods SET status = 'completed', processed_at = NOW() WHERE id = $1`,
                [payroll_period_id]
            );

            return {
                success: true,
                message: `Payroll generated for ${generated.length} employee(s)`,
                data: {
                    generated_count: generated.length,
                    skipped_count: skipped.length,
                    error_count: errors.length,
                    generated,
                    skipped,
                    errors,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get payroll by ID (with full details)
    // ----------------------------------------------------------
    async getPayrollById(id) {
        try {
            const result = await PayrollModel.findById(id);
            if (!result) {
                return { success: false, message: "Payroll record not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get all payrolls for a company
    // ----------------------------------------------------------
    async getPayrollsByCompany(company_id) {
        try {
            const result = await PayrollModel.getAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get all payrolls for a specific period
    // ----------------------------------------------------------
    async getPayrollsByPeriod(company_id, payroll_period_id) {
        try {
            const result = await PayrollModel.getAllByPeriod(company_id, payroll_period_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get all payrolls for a specific employee
    // ----------------------------------------------------------
    async getPayrollsByEmployee(employee_id) {
        try {
            const result = await PayrollModel.getAllByEmployee(employee_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Update payroll status  (draft → processed → paid → cancelled)
    // ----------------------------------------------------------
    async updatePayrollStatus(id, payroll_status) {
        try {
            const VALID_STATUSES = ["draft", "processed", "paid", "cancelled"];
            if (!VALID_STATUSES.includes(payroll_status)) {
                return {
                    success: false,
                    message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
                };
            }

            const payroll = await PayrollModel.findById(id);
            if (!payroll) {
                return { success: false, message: "Payroll record not found" };
            }

            // Enforce status transition rules
            const transitions = {
                draft: ["processed", "cancelled"],
                processed: ["paid", "cancelled"],
                paid: [],         // terminal state
                cancelled: [],    // terminal state
            };
            if (!transitions[payroll.payroll_status].includes(payroll_status)) {
                return {
                    success: false,
                    message: `Cannot transition from '${payroll.payroll_status}' to '${payroll_status}'`,
                };
            }

            let result;
            if (payroll_status === "paid") {
                result = await PayrollModel.markAsPaid(id);
            } else {
                result = await PayrollModel.updateStatus(id, payroll_status);
            }

            return {
                success: true,
                message: `Payroll status updated to '${payroll_status}'`,
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Delete a payroll (only draft or cancelled allowed)
    // ----------------------------------------------------------
    async deletePayroll(id) {
        try {
            const payroll = await PayrollModel.findById(id);
            if (!payroll) {
                return { success: false, message: "Payroll record not found" };
            }
            if (!["draft", "cancelled"].includes(payroll.payroll_status)) {
                return {
                    success: false,
                    message: "Only draft or cancelled payrolls can be deleted",
                };
            }
            const result = await PayrollModel.delete(id);
            return { success: true, message: "Payroll deleted successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PayrollService;