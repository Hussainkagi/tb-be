const PayslipModel = require("../models/payslipModel");
const PayrollModel = require("../models/payrollModel");
const PayrollAdjustmentModel = require("../models/payrollAdjustmentModel");

const PayrollPeriodModel = require("../models/payrollPeriodModel");

// ============================================================
// UTILITY: Generate unique payslip number
// Format: PSL-{YYYYMM}-{EMPLOYEE_CODE}-{RANDOM4}
// ============================================================
function generatePayslipNumber(employee_code, periodStart) {
    const date = new Date(periodStart);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    const code = (employee_code || "EMP").replace(/\s+/g, "").toUpperCase();
    return `PSL-${yyyy}${mm}-${code}-${rand}`;
}

// ============================================================
// SERVICE
// ============================================================
const PayslipService = {

    // ----------------------------------------------------------
    // Generate payslip for a single payroll record
    // Only allowed when payroll_status = 'processed' or 'paid'
    // ----------------------------------------------------------
    async generatePayslip(payroll_id) {
        try {
            // 1. Fetch payroll with full details
            const payroll = await PayrollModel.findById(payroll_id);
            if (!payroll) {
                return { success: false, message: "Payroll record not found" };
            }

            const GENERATABLE_STATUSES = ["processed", "paid"];
            if (!GENERATABLE_STATUSES.includes(payroll.payroll_status)) {
                return {
                    success: false,
                    message: `Payslip can only be generated for processed or paid payrolls. Current status: '${payroll.payroll_status}'`,
                };
            }

            // 2. Check if payslip already exists
            const existing = await PayslipModel.findByPayrollId(payroll_id);
            if (existing) {
                return {
                    success: false,
                    message: "Payslip already exists for this payroll",
                    data: existing,
                };
            }

            // 3. Generate payslip number
            const payslipNumber = generatePayslipNumber(
                payroll.employee_code,
                payroll.period_start_date
            );

            // 4. Create payslip record
            const payslip = await PayslipModel.create({
                payroll_id,
                payslip_number: payslipNumber,
                pdf_url: null,  // PDF generated asynchronously or on-demand
            });

            return {
                success: true,
                message: "Payslip generated successfully",
                data: payslip,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Bulk-generate payslips for all payrolls in a period
    // Skips employees who already have a payslip
    // ----------------------------------------------------------
    async generatePayslipsForPeriod(company_id, payroll_period_id) {
        try {

            const period = await PayrollPeriodModel.findById(payroll_period_id);
            if (!period) {
                return { success: false, message: "Payroll period not found" };
            }
            const payrolls = await PayrollModel.getAllByPeriod(company_id, payroll_period_id);
            if (!payrolls || payrolls.length === 0) {
                return {
                    success: false,
                    message: "No payroll records found for this period",
                };
            }

            const generated = [];
            const skipped = [];
            const errors = [];

            for (const payroll of payrolls) {
                try {
                    if (!["processed", "paid"].includes(payroll.payroll_status)) {
                        skipped.push({
                            payroll_id: payroll.id,
                            reason: `Status is '${payroll.payroll_status}' — must be processed or paid`,
                        });
                        continue;
                    }

                    const existing = await PayslipModel.findByPayrollId(payroll.id);
                    if (existing) {
                        skipped.push({
                            payroll_id: payroll.id,
                            reason: "Payslip already exists",
                        });
                        continue;
                    }

                    const payslipNumber = generatePayslipNumber(
                        payroll.employee_code,
                        period.start_date
                    );

                    const payslip = await PayslipModel.create({
                        payroll_id: payroll.id,
                        payslip_number: payslipNumber,
                        pdf_url: null,
                    });

                    generated.push(payslip);
                } catch (err) {
                    errors.push({ payroll_id: payroll.id, error: err.message });
                }
            }

            return {
                success: true,
                message: `${generated.length} payslip(s) generated`,
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
    // Get a payslip by ID (with full context for rendering)
    // ----------------------------------------------------------
    async getPayslipById(id) {
        try {
            const payslip = await PayslipModel.findById(id);
            if (!payslip) {
                return { success: false, message: "Payslip not found" };
            }

            // Attach adjustments for rendering a complete payslip document
            const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payslip.payroll_id);

            return {
                success: true,
                data: { ...payslip, adjustments },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get payslip by payroll ID
    // ----------------------------------------------------------
    async getPayslipByPayrollId(payroll_id) {
        try {
            const payslip = await PayslipModel.findByPayrollId(payroll_id);
            if (!payslip) {
                return { success: false, message: "Payslip not found for this payroll" };
            }
            const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payroll_id);
            return { success: true, data: { ...payslip, adjustments } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get payslip by payslip number (e.g. from printed slip QR)
    // ----------------------------------------------------------
    async getPayslipByNumber(payslip_number) {
        try {
            const payslip = await PayslipModel.findByPayslipNumber(payslip_number);
            if (!payslip) {
                return { success: false, message: "Payslip not found" };
            }
            const adjustments = await PayrollAdjustmentModel.getAllByPayroll(payslip.payroll_id);
            return { success: true, data: { ...payslip, adjustments } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get all payslips for an employee (payslip history)
    // ----------------------------------------------------------
    async getPayslipsByEmployee(employee_id) {
        try {
            const result = await PayslipModel.getAllByEmployee(employee_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Get all payslips for a payroll period
    // ----------------------------------------------------------
    async getPayslipsByPeriod(payroll_period_id) {
        try {
            const result = await PayslipModel.getAllByPeriod(payroll_period_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Attach or update the PDF URL once the PDF is generated
    // ----------------------------------------------------------
    async updatePdfUrl(id, pdf_url) {
        try {
            if (!pdf_url || !pdf_url.trim()) {
                return { success: false, message: "pdf_url is required" };
            }

            const payslip = await PayslipModel.findById(id);
            if (!payslip) {
                return { success: false, message: "Payslip not found" };
            }

            const result = await PayslipModel.updatePdfUrl(id, pdf_url.trim());

            return {
                success: true,
                message: "PDF URL updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ----------------------------------------------------------
    // Delete a payslip (e.g. to regenerate after corrections)
    // Only allowed when payroll is in draft or processed state
    // ----------------------------------------------------------
    async deletePayslip(id) {
        try {
            const payslip = await PayslipModel.findById(id);
            if (!payslip) {
                return { success: false, message: "Payslip not found" };
            }

            // Guard: do not allow deletion if payroll is already paid
            const payroll = await PayrollModel.findById(payslip.payroll_id);
            if (payroll && payroll.payroll_status === "paid") {
                return {
                    success: false,
                    message: "Cannot delete a payslip linked to a paid payroll",
                };
            }

            const result = await PayslipModel.delete(id);
            return { success: true, message: "Payslip deleted successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PayslipService;