const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");
const PayrollModel = require("../models/payrollModel");

// ============================================================
// CONSTANTS
// ============================================================
const VALID_ADJUSTMENT_TYPES = ["bonus", "deduction", "commission", "penalty", "loan"];

// After an adjustment is added/removed, recalculate the payroll
// totals that depend on adjustments (bonus_amount, deduction_amount, net_salary)
async function syncPayrollTotals(payroll_id) {
    const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll_id);

    let bonusAmount = 0;
    let deductionAmount = 0;

    for (const adj of adjustments) {
        const amount = parseFloat(adj.amount) || 0;
        if (["bonus", "commission"].includes(adj.adjustment_type)) {
            bonusAmount += amount;
        } else if (["deduction", "penalty", "loan"].includes(adj.adjustment_type)) {
            deductionAmount += amount;
        }
    }

    // Fetch current payroll to get the base values
    const payroll = await PayrollModel.findById(payroll_id);
    const grossSalary = parseFloat(payroll.gross_salary) || 0;
    const overtimeAmount = parseFloat(payroll.overtime_amount) || 0;
    const taxAmount = parseFloat(payroll.tax_amount) || 0;

    // Net = gross + overtime + bonus - deductions - tax
    const netSalary = parseFloat(
        (grossSalary + overtimeAmount + bonusAmount - deductionAmount - taxAmount).toFixed(2)
    );

    await PayrollModel.update(payroll_id, {
        bonus_amount: parseFloat(bonusAmount.toFixed(2)),
        deduction_amount: parseFloat(deductionAmount.toFixed(2)),
        net_salary: netSalary,
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

            // Ensure payroll exists and is editable
            const payroll = await PayrollModel.findById(payroll_id);
            if (!payroll) {
                return { success: false, message: "Payroll record not found" };
            }
            if (payroll.payroll_status === "paid") {
                return { success: false, message: "Cannot add adjustments to a paid payroll" };
            }
            if (payroll.payroll_status === "cancelled") {
                return { success: false, message: "Cannot add adjustments to a cancelled payroll" };
            }

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

            const payroll = await PayrollModel.findById(payroll_id);
            if (!payroll) {
                return { success: false, message: "Payroll record not found" };
            }
            if (["paid", "cancelled"].includes(payroll.payroll_status)) {
                return {
                    success: false,
                    message: `Cannot add adjustments to a ${payroll.payroll_status} payroll`,
                };
            }

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

            // Check payroll editability
            const payroll = await PayrollModel.findById(adjustment.payroll_id);
            if (["paid", "cancelled"].includes(payroll.payroll_status)) {
                return {
                    success: false,
                    message: `Cannot update adjustments on a ${payroll.payroll_status} payroll`,
                };
            }

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

            const payroll = await PayrollModel.findById(adjustment.payroll_id);
            if (["paid", "cancelled"].includes(payroll.payroll_status)) {
                return {
                    success: false,
                    message: `Cannot delete adjustments from a ${payroll.payroll_status} payroll`,
                };
            }

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
            const payroll = await PayrollModel.findById(payroll_id);
            if (!payroll) {
                return { success: false, message: "Payroll record not found" };
            }
            if (["paid", "cancelled"].includes(payroll.payroll_status)) {
                return {
                    success: false,
                    message: `Cannot clear adjustments from a ${payroll.payroll_status} payroll`,
                };
            }

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