const db = require("../config/database");
const PayrollModel = require("../models/payrollModel");
const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");
const PayrollDailyLineModel = require("../models/payrollDailyLineModel");
const PayrollSettingsModel = require("../models/payrollSettingsModel");
const { buildShift, buildDailyBreakdown, getDateRange } = require("./payrollEngineService");
const { PAYROLL_STATUS, PAYROLL_STATUS_TRANSITIONS } = require("../enums/payrollFlow");

// ============================================================
// DATA FETCHERS — isolated DB queries used by the engine
// ============================================================

async function fetchPayrollPeriod(payroll_period_id) {
    const result = await db.query(
        `SELECT
                *,
                start_date::date::text AS start_date,
                end_date::date::text   AS end_date
            FROM payroll_periods
            WHERE id = $1`,
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
        `SELECT e.*,
                e.joining_date::date::text AS joining_date,
                e.exit_date::date::text    AS exit_date,
                s.shift_name, s.working_hours, s.half_day_hours,
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
        getDateRange(row.holiday_start_date, row.holiday_end_date).forEach((d) => holidaySet.add(d));
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
// Adjustment totals — one definition, used everywhere.
// Previously three call sites each rolled their own, and one of
// them classified only 'bonus'/'deduction', silently dropping
// commissions, penalties and loans from the paid amount.
// ============================================================
const DEDUCTION_TYPES = ["deduction", "penalty", "loan"];
const BONUS_TYPES = ["bonus", "commission"];

function totalsFromAdjustments(adjustments = []) {
    let bonus = 0;
    let deduction = 0;
    for (const adj of adjustments) {
        const amount = parseFloat(adj.amount) || 0;
        if (DEDUCTION_TYPES.includes(adj.adjustment_type)) deduction += amount;
        else if (BONUS_TYPES.includes(adj.adjustment_type)) bonus += amount;
    }
    return {
        bonus: parseFloat(bonus.toFixed(2)),
        deduction: parseFloat(deduction.toFixed(2)),
    };
}

/**
 * The single net-salary formula. base_* hold the attendance-derived figures
 * frozen at generation time; adjustments layer on top. Recomputing from the
 * base each time means editing an adjustment can never compound.
 */
function computeFinalFigures(payroll, adjustments) {
    const { bonus, deduction } = totalsFromAdjustments(adjustments);

    const totalDeduction = (parseFloat(payroll.base_deduction_amount) || 0) + deduction;
    const totalBonus = (parseFloat(payroll.base_bonus_amount) || 0) + bonus;
    const netSalary =
        (parseFloat(payroll.gross_salary) || 0)
        - totalDeduction
        + (parseFloat(payroll.overtime_amount) || 0)
        + totalBonus
        - (parseFloat(payroll.tax_amount) || 0);

    return {
        adjustment_bonus: bonus,
        adjustment_deduction: deduction,
        bonus_amount: parseFloat(totalBonus.toFixed(2)),
        deduction_amount: parseFloat(totalDeduction.toFixed(2)),
        net_salary: parseFloat(netSalary.toFixed(2)),
    };
}

async function withPreview(payroll) {
    const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll.id);
    const figures = computeFinalFigures(payroll, adjustments);
    return {
        ...payroll,
        adjustments,
        preview_bonus: figures.bonus_amount,
        preview_deduction: figures.deduction_amount,
        preview_net_salary: figures.net_salary,
    };
}

// ============================================================
// MAIN SERVICE
// ============================================================
const PayrollService = {

    // ----------------------------------------------------------
    // Generate payroll for a single branch OR entire company.
    //
    // Runs inside one transaction: either every employee lands or
    // none do, so a crash halfway can never leave a period with a
    // partial, silently-wrong payroll.
    //
    // @param {boolean} data.force  regenerate employees that already
    //                              have a payroll for this period
    // ----------------------------------------------------------
    async generatePayroll(data) {
        const {
            company_id,
            payroll_period_id,
            branch_id = null,
            user_id,
            payroll_run_id = null,
            force = false,
        } = data;

        const generated = [];
        const skipped = [];
        const errors = [];

        const client = await db.getClient();

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

            // ── STEP 2: Fetch active employees + company rules ─
            const [employees, settings] = await Promise.all([
                fetchActiveEmployees(company_id, branch_id),
                PayrollSettingsModel.getOrCreate(company_id),
            ]);
            if (employees.length === 0) {
                return { success: false, message: "No active employees found" };
            }

            await client.query("BEGIN");

            // ── STEP 3: Process each employee ─────────────────
            for (const employee of employees) {
                try {
                    const existing = await PayrollModel.findByEmployeeAndPeriod(
                        employee.id,
                        payroll_period_id
                    );

                    if (existing && !force) {
                        skipped.push({
                            employee_id: employee.id,
                            employee_code: employee.employee_code,
                            reason: "Payroll already exists",
                        });
                        continue;
                    }
                    if (existing && ["paid", "cancelled"].includes(existing.payroll_status)) {
                        skipped.push({
                            employee_id: employee.id,
                            employee_code: employee.employee_code,
                            reason: `Cannot regenerate a '${existing.payroll_status}' payroll`,
                        });
                        continue;
                    }

                    const salaryStructure = await fetchSalaryStructure(employee.id, period.start_date);
                    if (!salaryStructure) {
                        skipped.push({
                            employee_id: employee.id,
                            employee_code: employee.employee_code,
                            reason: "No active salary structure found",
                        });
                        continue;
                    }

                    const shift = buildShift(employee);
                    const empBranchId = employee.branch_id;

                    const [attendanceMap, holidaySet, approvedLeaves] = await Promise.all([
                        fetchAttendanceForPeriod(employee.id, period.start_date, period.end_date),
                        fetchHolidaysForPeriod(company_id, empBranchId, period.start_date, period.end_date),
                        fetchApprovedLeaves(employee.id, period.start_date, period.end_date),
                    ]);

                    // The same engine the breakdown page reads from — this is
                    // what keeps the list view and the day-by-day view in sync.
                    const breakdown = buildDailyBreakdown({
                        period,
                        shift,
                        salaryStructure,
                        attendanceMap,
                        approvedLeaves,
                        holidaySet,
                        employee,
                        settings,
                    });
                    const calc = breakdown.summary;

                    const payload = {
                        company_id,
                        payroll_period_id,
                        payroll_run_id,
                        employee_id: employee.id,
                        branch_id: empBranchId,
                        actual_salary: calc.actual_salary,
                        gross_salary: calc.gross_salary,
                        per_day_salary: calc.per_day_salary,
                        total_working_days: calc.total_working_days,
                        total_present_days: calc.total_present_days,
                        total_absent_days: calc.total_absent_days,
                        total_paid_leave_days: calc.total_paid_leave_days,
                        total_unpaid_leave_days: calc.total_unpaid_leave_days,
                        total_holidays: calc.total_holidays,
                        sandwich_days: calc.sandwich_days,
                        payable_days: calc.payable_days,
                        not_employed_days: calc.not_employed_days,
                        overtime_hours: calc.overtime_hours,
                        overtime_amount: calc.overtime_amount,
                        deduction_amount: calc.deduction_amount,
                        net_salary: calc.net_salary,
                        base_deduction_amount: calc.deduction_amount,
                        base_bonus_amount: 0,
                        bonus_amount: 0,
                        tax_amount: 0,
                        payroll_status: PAYROLL_STATUS.PROCESSED,
                    };

                    let payroll;
                    if (existing) {
                        // Regenerate in place so adjustments keyed to this
                        // payroll_id survive; only the computed figures change.
                        payroll = await PayrollModel.update(existing.id, payload, client);
                        await PayrollDailyLineModel.deleteByPayrollId(existing.id, client);
                    } else {
                        payroll = await PayrollModel.create(payload, client);
                    }

                    // Freeze the day-by-day snapshot so the breakdown always
                    // matches what was generated here, regardless of later
                    // attendance / leave / holiday edits.
                    await PayrollDailyLineModel.bulkInsert(payroll.id, breakdown.daily, client);

                    // Re-apply any existing adjustments to the fresh base.
                    const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll.id);
                    if (adjustments.length > 0) {
                        const figures = computeFinalFigures(payroll, adjustments);
                        payroll = await PayrollModel.update(payroll.id, {
                            bonus_amount: figures.bonus_amount,
                            deduction_amount: figures.deduction_amount,
                            net_salary: figures.net_salary,
                        }, client);
                    }

                    generated.push(payroll);
                } catch (empError) {
                    errors.push({
                        employee_id: employee.id,
                        employee_code: employee.employee_code,
                        error: empError.message,
                    });
                }
            }

            if (generated.length === 0 && errors.length > 0) {
                await client.query("ROLLBACK");
                return {
                    success: false,
                    message: "Payroll generation failed for every employee",
                    data: { skipped, errors },
                };
            }

            await client.query(
                `UPDATE payroll_periods
                 SET status = 'processing', processed_at = NOW(), processed_by = $2
                 WHERE id = $1`,
                [payroll_period_id, user_id]
            );

            await client.query("COMMIT");

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
            await client.query("ROLLBACK").catch(() => { });
            return { success: false, message: error.message, error };
        } finally {
            client.release();
        }
    },

    // ----------------------------------------------------------
    // Get payroll by ID (with adjustments + live preview figures)
    // ----------------------------------------------------------
    async getPayrollById(id) {
        try {
            const result = await PayrollModel.findById(id);
            if (!result) {
                return { success: false, message: "Payroll record not found" };
            }
            return { success: true, data: await withPreview(result) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollsByCompany(company_id) {
        try {
            const result = await PayrollModel.getAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollsByPeriod(company_id, payroll_period_id) {
        try {
            const result = await PayrollModel.getAllByPeriod(company_id, payroll_period_id);
            const payrolls = await Promise.all(result.map(withPreview));
            return { success: true, data: payrolls };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollsByEmployee(employee_id) {
        try {
            const result = await PayrollModel.getAllByEmployee(employee_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Recalculate stored figures for one payroll from its frozen
    // base + current adjustments. Called whenever an adjustment
    // is added, changed or removed, so the stored net_salary is
    // always the number that will actually be paid.
    // ----------------------------------------------------------
    async recalculatePayroll(id) {
        try {
            const payroll = await PayrollModel.findById(id);
            if (!payroll) return { success: false, message: "Payroll record not found" };
            if (["paid", "cancelled"].includes(payroll.payroll_status)) {
                return { success: false, message: `Cannot recalculate a '${payroll.payroll_status}' payroll` };
            }

            const adjustments = await PayrollAdjustmentModel.getAllByPayroll(id);
            const figures = computeFinalFigures(payroll, adjustments);

            const updated = await PayrollModel.update(id, {
                bonus_amount: figures.bonus_amount,
                deduction_amount: figures.deduction_amount,
                net_salary: figures.net_salary,
            });

            return { success: true, message: "Payroll recalculated", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Update payroll status
    // draft → processed → approved → paid   (or cancelled/rejected)
    // ----------------------------------------------------------
    async updatePayrollStatus(id, payroll_status) {
        try {
            const VALID_STATUSES = Object.values(PAYROLL_STATUS);
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

            // An unknown current status used to crash here with
            // "Cannot read properties of undefined (reading 'includes')".
            const allowed = PAYROLL_STATUS_TRANSITIONS[payroll.payroll_status] || [];
            if (!allowed.includes(payroll_status)) {
                return {
                    success: false,
                    message: `Cannot transition from '${payroll.payroll_status}' to '${payroll_status}'`
                        + `. Allowed: ${allowed.length ? allowed.join(", ") : "none"}`,
                };
            }

            let result;
            if (payroll_status === PAYROLL_STATUS.PAID) {
                // Freeze the final figures at the moment of payment.
                const adjustments = await PayrollAdjustmentModel.getAllByPayroll(id);
                const figures = computeFinalFigures(payroll, adjustments);

                result = await PayrollModel.update(id, {
                    bonus_amount: figures.bonus_amount,
                    deduction_amount: figures.deduction_amount,
                    net_salary: figures.net_salary,
                    payroll_status: PAYROLL_STATUS.PAID,
                    paid_at: new Date(),
                });
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

    // ----------------------------------------------------------
    // Bulk status change across a whole period.
    //
    // Kept for direct/API use. The run orchestrator
    // (payrollRunService) is the path the UI should take, because
    // it also records who approved what.
    // ----------------------------------------------------------
    async bulkUpdatePayrollStatus(company_id, payroll_period_id, payroll_status, options = {}) {
        const client = options.client || null;
        const runner = client || db;

        try {
            const VALID_STATUSES = ["approved", "rejected", "paid", "cancelled"];
            if (!VALID_STATUSES.includes(payroll_status)) {
                return {
                    success: false,
                    message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
                };
            }

            const period = await fetchPayrollPeriod(payroll_period_id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }
            if (period.company_id !== company_id) {
                return { success: false, message: "Payroll period does not belong to this company" };
            }

            const validFromStatuses = {
                approved: ["processed", "rejected"],
                rejected: ["processed", "approved"],
                paid: ["approved"],                 // payment now requires approval first
                cancelled: ["draft", "processed", "approved", "rejected"],
            };

            const payrolls = await PayrollModel.getAllByPeriod(company_id, payroll_period_id);
            if (payrolls.length === 0) {
                return { success: false, message: "No payrolls found for this period" };
            }

            const eligible = payrolls.filter((p) =>
                validFromStatuses[payroll_status].includes(p.payroll_status)
            );
            const skipped = payrolls.filter((p) =>
                !validFromStatuses[payroll_status].includes(p.payroll_status)
            );

            if (eligible.length === 0) {
                return {
                    success: false,
                    message: `No payrolls eligible for '${payroll_status}'.`
                        + ` Allowed source statuses: ${validFromStatuses[payroll_status].join(", ")}.`,
                };
            }

            let updatedRows;

            if (payroll_status === "paid") {
                updatedRows = await Promise.all(eligible.map(async (payroll) => {
                    const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll.id);
                    const figures = computeFinalFigures(payroll, adjustments);
                    return PayrollModel.update(payroll.id, {
                        bonus_amount: figures.bonus_amount,
                        deduction_amount: figures.deduction_amount,
                        net_salary: figures.net_salary,
                        payroll_status: "paid",
                        paid_at: new Date(),
                    }, runner);
                }));
            } else {
                const result = await runner.query(
                    `UPDATE payrolls
                        SET payroll_status = $1, updated_at = NOW()
                      WHERE id = ANY($2::uuid[])
                      RETURNING *`,
                    [payroll_status, eligible.map((p) => p.id)]
                );
                updatedRows = result.rows;
            }

            return {
                success: true,
                message: `${updatedRows.length} payroll(s) marked as '${payroll_status}'`,
                data: {
                    updated_count: updatedRows.length,
                    skipped_count: skipped.length,
                    skipped: skipped.map((p) => ({
                        payroll_id: p.id,
                        employee_id: p.employee_id,
                        employee_code: p.employee_code,
                        current_status: p.payroll_status,
                        reason: `Cannot transition from '${p.payroll_status}' to '${payroll_status}'`,
                    })),
                    updated: updatedRows,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PayrollService;
module.exports.computeFinalFigures = computeFinalFigures;
module.exports.totalsFromAdjustments = totalsFromAdjustments;
module.exports.fetchPayrollPeriod = fetchPayrollPeriod;
