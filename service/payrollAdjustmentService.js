const db = require("../config/database");
const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");
const PayrollModel = require("../models/payrollModel");
const { computeFinalFigures } = require("./payrollService");
const { EDITABLE_STATUSES } = require("../enums/payrollFlow");

// ============================================================
// CONSTANTS
// ============================================================
const VALID_ADJUSTMENT_TYPES = ["bonus", "deduction", "commission", "penalty", "loan"];

/**
 * Adjustments may only be touched while the payroll is still the maker's to
 * change. Without this, someone could quietly add a bonus to a run that had
 * already been approved — the approver's sign-off would no longer describe
 * what actually gets paid, which defeats maker-checker entirely.
 */
async function assertPayrollEditable(payroll_id) {
    const payroll = await PayrollModel.findById(payroll_id);
    if (!payroll) return { error: { success: false, message: "Payroll record not found" } };

    if (["paid", "cancelled"].includes(payroll.payroll_status)) {
        return {
            error: {
                success: false,
                message: `Cannot change adjustments on a '${payroll.payroll_status}' payroll`,
            },
        };
    }

    if (payroll.payroll_run_id) {
        const run = await db.query(
            `SELECT status FROM payroll_runs WHERE id = $1`,
            [payroll.payroll_run_id]
        ).then((r) => r.rows[0]);

        if (run && !EDITABLE_STATUSES.includes(run.status)) {
            return {
                error: {
                    success: false,
                    message: `This payroll run is '${run.status}' and is locked for edits.`
                        + (run.status === "pending_approval"
                            ? " Ask the approver to reject it first."
                            : ""),
                },
            };
        }
    }

    return { payroll };
}

// After an adjustment is added/removed, recalculate the payroll totals that
// depend on adjustments. The formula itself lives in payrollService so the
// stored net salary always matches the previews shown elsewhere.
async function syncPayrollTotals(payroll_id) {
    const payroll = await PayrollModel.findById(payroll_id);
    if (!payroll) return;

    const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll_id);
    const figures = computeFinalFigures(payroll, adjustments);

    await PayrollModel.update(payroll_id, {
        bonus_amount: figures.bonus_amount,
        deduction_amount: figures.deduction_amount,
        net_salary: figures.net_salary,
    });
}

// ============================================================
// SERVICE
// ============================================================
const PayrollAdjustmentService = {

    // ----------------------------------------------------------
    // Add a single adjustment to a payroll
    // ----------------------------------------------------------
    async addAdjustment(data) {
        try {
            const { payroll_id, adjustment_type, title, amount, is_taxable, remarks } = data;

            // Validate type
            if (!VALID_ADJUSTMENT_TYPES.includes(adjustment_type)) {
                return {
                    success: false,
                    message: `Invalid adjustment type. Must be one of: ${VALID_ADJUSTMENT_TYPES.join(", ")}`,
                };
            }

            // Validate amount
            if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
                return { success: false, message: "Amount must be a positive number" };
            }

            // Ensure the payroll — and the run it belongs to — still accept edits
            const { error } = await assertPayrollEditable(payroll_id);
            if (error) return error;

            const result = await PayrollAdjustmentModel.create({
                payroll_id,
                adjustment_type,
                title,
                amount: parseFloat(amount),
                is_taxable: is_taxable ?? false,
                remarks: remarks ?? null,
            });

            // Sync payroll totals after adding adjustment
            await syncPayrollTotals(payroll_id);

            return {
                success: true,
                message: "Adjustment added successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Bulk-add adjustments (e.g. import from Excel / batch bonus)
    // ----------------------------------------------------------
    async addAdjustmentsBulk(payroll_id, adjustments) {
        try {
            if (!Array.isArray(adjustments) || adjustments.length === 0) {
                return { success: false, message: "Adjustments array is required and cannot be empty" };
            }

            const { error } = await assertPayrollEditable(payroll_id);
            if (error) return error;

            // Validate each item
            for (let i = 0; i < adjustments.length; i++) {
                const adj = adjustments[i];
                if (!VALID_ADJUSTMENT_TYPES.includes(adj.adjustment_type)) {
                    return {
                        success: false,
                        message: `Item [${i}]: invalid adjustment_type '${adj.adjustment_type}'`,
                    };
                }
                if (!adj.amount || isNaN(adj.amount) || parseFloat(adj.amount) <= 0) {
                    return {
                        success: false,
                        message: `Item [${i}]: amount must be a positive number`,
                    };
                }
                if (!adj.title || !adj.title.trim()) {
                    return { success: false, message: `Item [${i}]: title is required` };
                }
            }

            const result = await PayrollAdjustmentModel.createMany(payroll_id, adjustments);

            // Sync payroll totals after bulk add
            await syncPayrollTotals(payroll_id);

            return {
                success: true,
                message: `${result.length} adjustment(s) added successfully`,
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get a single adjustment by ID
    // ----------------------------------------------------------
    async getAdjustmentById(id) {
        try {
            const result = await PayrollAdjustmentModel.findById(id);
            if (!result) {
                return { success: false, message: "Adjustment not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get all adjustments for a payroll
    // ----------------------------------------------------------
    async getAdjustmentsByPayroll(payroll_id) {
        try {
            const result = await PayrollAdjustmentModel.getAllByPayroll(payroll_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get adjustments filtered by type
    // ----------------------------------------------------------
    async getAdjustmentsByType(payroll_id, adjustment_type) {
        try {
            if (!VALID_ADJUSTMENT_TYPES.includes(adjustment_type)) {
                return {
                    success: false,
                    message: `Invalid adjustment type. Must be one of: ${VALID_ADJUSTMENT_TYPES.join(", ")}`,
                };
            }
            const result = await PayrollAdjustmentModel.getAllByPayrollAndType(
                payroll_id,
                adjustment_type
            );
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Update an adjustment
    // ----------------------------------------------------------
    async updateAdjustment(id, data) {
        try {
            const adjustment = await PayrollAdjustmentModel.findById(id);
            if (!adjustment) {
                return { success: false, message: "Adjustment not found" };
            }

            const { error } = await assertPayrollEditable(adjustment.payroll_id);
            if (error) return error;

            // Validate type if being changed
            if (data.adjustment_type && !VALID_ADJUSTMENT_TYPES.includes(data.adjustment_type)) {
                return {
                    success: false,
                    message: `Invalid adjustment type. Must be one of: ${VALID_ADJUSTMENT_TYPES.join(", ")}`,
                };
            }

            // Validate amount if being changed
            if (data.amount !== undefined && (isNaN(data.amount) || parseFloat(data.amount) <= 0)) {
                return { success: false, message: "Amount must be a positive number" };
            }

            // Prevent changing payroll_id
            delete data.payroll_id;

            const result = await PayrollAdjustmentModel.update(id, data);

            // Sync payroll totals
            await syncPayrollTotals(adjustment.payroll_id);

            return {
                success: true,
                message: "Adjustment updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Delete a single adjustment
    // ----------------------------------------------------------
    async deleteAdjustment(id) {
        try {
            const adjustment = await PayrollAdjustmentModel.findById(id);
            if (!adjustment) {
                return { success: false, message: "Adjustment not found" };
            }

            const { error } = await assertPayrollEditable(adjustment.payroll_id);
            if (error) return error;

            const result = await PayrollAdjustmentModel.delete(id);

            // Sync payroll totals after removal
            await syncPayrollTotals(adjustment.payroll_id);

            return {
                success: true,
                message: "Adjustment deleted successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Delete all adjustments for a payroll (used when re-processing)
    // ----------------------------------------------------------
    async deleteAllAdjustments(payroll_id) {
        try {
            const { error } = await assertPayrollEditable(payroll_id);
            if (error) return error;

            const result = await PayrollAdjustmentModel.deleteAllByPayroll(payroll_id);

            // Reset bonus/deduction amounts on payroll
            await syncPayrollTotals(payroll_id);

            return {
                success: true,
                message: `${result.length} adjustment(s) deleted`,
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PayrollAdjustmentService;