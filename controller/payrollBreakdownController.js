const PayrollBreakdownService = require("../service/payrollBreakDownService");

const PayrollBreakdownController = {

    // GET /api/v1/payroll/:id/breakdown
    async getByPayrollId(req, res) {
        try {
            const result = await PayrollBreakdownService.getBreakdownByPayrollId(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            }
            return res.status(404).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // GET /api/v1/payroll/period/:company_id/:payroll_period_id/breakdown
    async getByPeriod(req, res) {
        try {
            const { company_id, payroll_period_id } = req.params;
            const result = await PayrollBreakdownService.getBreakdownByPeriod(company_id, payroll_period_id);
            if (result.success) {
                return res.status(200).json(result);
            }
            return res.status(404).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
    /** Repair the frozen daily-line snapshot for one payroll. */
    async rebuild(req, res) {
        try {
            const result = await PayrollBreakdownService.rebuildBreakdown(req.params.id);
            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = PayrollBreakdownController;