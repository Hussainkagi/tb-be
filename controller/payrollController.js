const PayrollService = require("../service/payrollService");

const PayrollController = {

    async generatePayroll(req, res) {
        try {
            const result = await PayrollService.generatePayroll({
                ...req.body,
                user_id: req.user.user_id,
            });
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /** Re-derive stored figures from the frozen base + current adjustments. */
    async recalculate(req, res) {
        try {
            const result = await PayrollService.recalculatePayroll(req.params.id);
            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getById(req, res) {
        try {
            const result = await PayrollService.getPayrollById(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByCompany(req, res) {
        try {
            const result = await PayrollService.getPayrollsByCompany(req.params.company_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByPeriod(req, res) {
        try {
            const { company_id, payroll_period_id } = req.params;
            const result = await PayrollService.getPayrollsByPeriod(company_id, payroll_period_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByEmployee(req, res) {
        try {
            const result = await PayrollService.getPayrollsByEmployee(req.params.employee_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async updateStatus(req, res) {
        try {
            const result = await PayrollService.updatePayrollStatus(req.params.id, req.body.payroll_status);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async bulkUpdateStatus(req, res) {
        try {
            const { company_id, payroll_period_id } = req.params;
            const { payroll_status } = req.body;
            const result = await PayrollService.bulkUpdatePayrollStatus(
                company_id,
                payroll_period_id,
                payroll_status
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async delete(req, res) {
        try {
            const result = await PayrollService.deletePayroll(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = PayrollController;