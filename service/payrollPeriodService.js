const PayrollPeriodModel = require("../models/payrollPeriodModel");
const PayrollModel = require("../models/payrollModel");
const { monthBoundsOf } = require("./payrollEngineService");

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/**
 * Turn { month: 8, year: 2026 } into the dates and name for that month.
 *
 * The dates are computed here rather than accepted from the client so a
 * "monthly payroll" is genuinely the whole month — no off-by-one on the last
 * day of February, no accidental 30 September on a 31-day month.
 */
const monthPeriod = (month, year) => {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);

    if (!Number.isInteger(m) || m < 1 || m > 12) return { error: "month must be a number between 1 and 12" };
    if (!Number.isInteger(y) || y < 2000 || y > 2100) return { error: "year must be a valid 4-digit year" };

    const { start, end } = monthBoundsOf(`${y}-${String(m).padStart(2, "0")}-01`);
    return { start_date: start, end_date: end, period_name: `${MONTH_NAMES[m - 1]} ${y}` };
};

/** Does this range cover exactly one whole calendar month? */
const isWholeMonth = (start_date, end_date) => {
    const { start, end } = monthBoundsOf(String(start_date).slice(0, 10));
    return String(start_date).slice(0, 10) === start && String(end_date).slice(0, 10) === end;
};

// Period status mirrors the payroll run that drives it. The run is the
// authority — payrollRunService moves the period along as each step lands.
const VALID_STATUSES = ["open", "processing", "pending_approval", "approved", "completed", "locked"];

// Allowed transitions: what status can move to what
const STATUS_TRANSITIONS = {
    open: ["processing"],
    processing: ["pending_approval", "approved", "completed", "open"],
    pending_approval: ["approved", "processing"],   // rejection drops back to processing
    approved: ["completed", "processing"],
    completed: ["locked"],
    locked: [],
};

const PayrollPeriodService = {

    /**
     * Create a payroll period.
     *
     * Two ways in:
     *
     *   { month: 8, year: 2026 }                    ← the normal path
     *   { start_date, end_date, is_off_cycle: true } ← final settlements, ad-hoc runs
     *
     * Month + year is the default because a monthly salary is earned over a
     * month, and a period that is not a month is almost always a mistake. The
     * daily rate itself is now month-derived either way (see
     * payrollEngineService.buildPerDayResolver), so a short period no longer
     * corrupts the maths — but it still produces a payslip covering two days,
     * which is rarely what someone clicking "run payroll" intended.
     *
     * A custom range therefore has to say so explicitly with is_off_cycle.
     * That keeps mid-month final settlements possible while making the
     * accidental 23–24 August run impossible.
     */
    async createPayrollPeriod(data) {
        try {
            const { company_id, month, year, is_off_cycle = false } = data;
            let { period_name, start_date, end_date } = data;

            if (!company_id) {
                return { success: false, message: "company_id is required" };
            }

            // ── Month + year → dates ─────────────────────────────────────
            // Truthiness, not `!== undefined`: callers that always pass the
            // field (payrollRunService threads month/year through as null when
            // the caller used dates) must not be treated as choosing the month
            // path with an empty month.
            if (month || year) {
                const derived = monthPeriod(month, year);
                if (derived.error) return { success: false, message: derived.error };

                start_date = derived.start_date;
                end_date = derived.end_date;
                period_name = period_name || derived.period_name;
            } else if (!start_date || !end_date) {
                return {
                    success: false,
                    message: "Provide month and year (e.g. { month: 8, year: 2026 }), or start_date and end_date with is_off_cycle: true for an off-cycle run",
                };
            } else if (!is_off_cycle && !isWholeMonth(start_date, end_date)) {
                // The guard that would have caught the 23–24 August run.
                const { start, end } = monthBoundsOf(String(start_date).slice(0, 10));
                return {
                    success: false,
                    message: `A payroll period should cover a whole month (${start} → ${end}). Pass month and year instead, or set is_off_cycle: true if this really is a partial run such as a final settlement.`,
                };
            }

            if (!period_name) {
                return { success: false, message: "period_name is required" };
            }

            if (new Date(end_date) <= new Date(start_date)) {
                return { success: false, message: "end_date must be after start_date" };
            }

            const existing = await PayrollPeriodModel.findByName(company_id, period_name);
            if (existing) {
                return { success: false, message: "A payroll period with this name already exists for the company" };
            }

            const overlapping = await PayrollPeriodModel.findOverlapping(company_id, start_date, end_date);
            if (overlapping) {
                return {
                    success: false,
                    message: `Date range overlaps with existing period "${overlapping.period_name}" (${overlapping.start_date} → ${overlapping.end_date})`,
                };
            }

            const result = await PayrollPeriodModel.create({
                ...data, period_name, start_date, end_date,
            });
            return {
                success: true,
                message: "Payroll period created successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollPeriodById(id) {
        try {
            const result = await PayrollPeriodModel.findById(id);
            if (!result) {
                return { success: false, message: "Payroll period not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollPeriodsByCompany(company_id) {
        try {
            const result = await PayrollPeriodModel.getAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollPeriodsByStatus(company_id, status) {
        try {
            if (!VALID_STATUSES.includes(status)) {
                return { success: false, message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` };
            }

            const result = await PayrollPeriodModel.getAllByStatus(company_id, status);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPayrollPeriodsByDateRange(company_id, start_date, end_date) {
        try {
            if (!start_date || !end_date) {
                return { success: false, message: "start_date and end_date are required" };
            }

            if (new Date(end_date) <= new Date(start_date)) {
                return { success: false, message: "end_date must be after start_date" };
            }

            const result = await PayrollPeriodModel.getByDateRange(company_id, start_date, end_date);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updatePayrollPeriod(id, data) {
        try {
            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            if (period.status === "locked") {
                return { success: false, message: "Locked payroll periods cannot be modified" };
            }

            // These are managed via dedicated methods only
            delete data.status;
            delete data.company_id;
            delete data.processed_at;
            delete data.processed_by;

            if (data.start_date || data.end_date) {
                const start_date = String(data.start_date || period.start_date).slice(0, 10);
                const end_date = String(data.end_date || period.end_date).slice(0, 10);

                if (new Date(end_date) <= new Date(start_date)) {
                    return { success: false, message: "end_date must be after start_date" };
                }

                // The same rule create enforces. Without it the guard is a
                // front door with the back door open: create "August 2026",
                // then edit it down to 23–24 August and the period is partial
                // again with nothing recording that anyone meant it.
                const offCycle = data.is_off_cycle ?? period.is_off_cycle;
                if (!offCycle && !isWholeMonth(start_date, end_date)) {
                    const { start, end } = monthBoundsOf(start_date);
                    return {
                        success: false,
                        message: `A payroll period should cover a whole month (${start} → ${end}). Set is_off_cycle: true if this really is a partial run such as a final settlement.`,
                    };
                }
            }

            if (data.period_name && data.period_name !== period.period_name) {
                const existing = await PayrollPeriodModel.findByName(period.company_id, data.period_name);
                if (existing) {
                    return { success: false, message: "A payroll period with this name already exists for the company" };
                }
            }

            const result = await PayrollPeriodModel.update(id, data);
            if (!result) {
                return { success: false, message: "Payroll period not found" };
            }
            return {
                success: true,
                message: "Payroll period updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updatePayrollPeriodStatus(id, status) {
        try {
            if (!VALID_STATUSES.includes(status)) {
                return { success: false, message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` };
            }

            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            const allowed = STATUS_TRANSITIONS[period.status];
            if (!allowed.includes(status)) {
                return {
                    success: false,
                    message: `Cannot transition from '${period.status}' to '${status}'. Allowed: ${allowed.length ? allowed.join(", ") : "none"}`,
                };
            }

            const result = await PayrollPeriodModel.updateStatus(id, status);
            return {
                success: true,
                message: `Payroll period status updated to '${status}'`,
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async markAsProcessed(id, processed_by) {
        try {
            if (!processed_by) {
                return { success: false, message: "processed_by (user_id) is required" };
            }

            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            if (period.status !== "processing") {
                return { success: false, message: `Only periods in 'processing' status can be marked as completed. Current status: '${period.status}'` };
            }

            const result = await PayrollPeriodModel.markAsProcessed(id, processed_by);
            return {
                success: true,
                message: "Payroll period marked as completed",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async lockPayrollPeriod(id) {
        try {
            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            if (period.status !== "completed") {
                return { success: false, message: `Only 'completed' periods can be locked. Current status: '${period.status}'` };
            }

            const result = await PayrollPeriodModel.lock(id);
            return {
                success: true,
                message: "Payroll period locked successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * What would deleting this period actually remove, and is it allowed?
     *
     * Exists so the confirmation dialog can be specific — "this removes 12
     * draft payrolls and 1 cancelled run" rather than "are you sure?". The
     * same guards as deletePayrollPeriod, evaluated without touching anything,
     * so the UI can also hide the action instead of offering something that
     * will be refused.
     */
    async getDeletionPreview(id) {
        try {
            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, status: 404, message: "Payroll period not found" };
            }

            const blockers = await PayrollPeriodModel.getDeletionBlockers(id);

            let can_delete = true;
            let reason = null;

            if (["locked", "completed"].includes(period.status)) {
                can_delete = false;
                reason = `This period is ${period.status} and cannot be deleted.`;
            } else if (blockers.paid_payrolls > 0 || blockers.payslips > 0) {
                const parts = [];
                if (blockers.paid_payrolls > 0) parts.push(`${blockers.paid_payrolls} employee(s) have already been paid`);
                if (blockers.payslips > 0) parts.push(`${blockers.payslips} payslip(s) have been issued`);
                can_delete = false;
                reason = `${parts.join(" and ")}.`;
            }

            return {
                success: true,
                data: {
                    period: {
                        id: period.id,
                        period_name: period.period_name,
                        start_date: period.start_date,
                        end_date: period.end_date,
                        status: period.status,
                    },
                    can_delete,
                    reason,
                    // What the delete would remove. payslips and paid_payrolls
                    // are zero whenever can_delete is true — they are the
                    // blockers, not casualties.
                    will_delete: {
                        payrolls: blockers.total_payrolls,
                        payroll_runs: blockers.runs,
                    },
                    blockers,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Delete a payroll period and everything generated under it.
     *
     * The case this exists for: an admin starts a run, gets a few steps in,
     * realises the period itself is wrong, and cancels. Cancelling reopens the
     * period but leaves its draft payrolls behind, and those pin it through an
     * ON DELETE RESTRICT foreign key — so the month could be neither used nor
     * recreated. It was a dead end in both directions.
     *
     * The line this will not cross is money. If any payroll is paid, or any
     * payslip has been issued, the period stays: an employee has been paid
     * against those records and a document exists with a number on it.
     * Everything short of that — draft, cancelled, approved-but-unpaid — is a
     * working figure, and erasing it is the point of the feature.
     *
     * Deletion is hard, not soft, because no table in this module carries
     * deleted_at and every payroll query would have to learn about the flag.
     * The audit trail does not depend on the rows: activityLogger records every
     * non-GET request, so who deleted what and when is captured regardless.
     */
    async deletePayrollPeriod(id) {
        try {
            const period = await PayrollPeriodModel.findById(id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }

            if (["locked", "completed"].includes(period.status)) {
                return {
                    success: false,
                    message: `Cannot delete a period with status "${period.status}". Only open or processing periods can be deleted.`,
                };
            }

            const blockers = await PayrollPeriodModel.getDeletionBlockers(id);

            // Named explicitly rather than left to the database. The FK would
            // refuse anyway, but with "violates foreign key constraint
            // payrolls_payroll_period_id_fkey" — which tells an admin nothing.
            if (blockers.paid_payrolls > 0 || blockers.payslips > 0) {
                const reasons = [];
                if (blockers.paid_payrolls > 0) reasons.push(`${blockers.paid_payrolls} employee(s) have already been paid`);
                if (blockers.payslips > 0) reasons.push(`${blockers.payslips} payslip(s) have been issued`);

                return {
                    success: false,
                    message: `This period cannot be deleted — ${reasons.join(" and ")}. Cancel the run instead; the period stays open and can be corrected.`,
                    data: { blockers },
                };
            }

            const result = await PayrollPeriodModel.deleteWithPayrolls(id);
            if (!result.period) {
                return { success: false, message: "Payroll period not found" };
            }

            const removed = [];
            if (result.deleted_payrolls > 0) removed.push(`${result.deleted_payrolls} draft payroll(s)`);
            if (blockers.runs > 0) removed.push(`${blockers.runs} payroll run(s)`);

            return {
                success: true,
                message: removed.length
                    ? `Payroll period deleted, along with ${removed.join(" and ")}. The month is free to be created again.`
                    : "Payroll period deleted. The month is free to be created again.",
                data: result.period,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PayrollPeriodService;