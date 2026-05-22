const PayslipService = require("../service/payslipService");

const PayslipController = {

    async generatePayslip(req, res) {
        try {
            const result = await PayslipService.generatePayslip(req.params.payroll_id);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async generatePayslipsForPeriod(req, res) {
        try {
            const { company_id, payroll_period_id } = req.params;
            const result = await PayslipService.generatePayslipsForPeriod(company_id, payroll_period_id);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getById(req, res) {
        try {
            const result = await PayslipService.getPayslipById(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByPayrollId(req, res) {
        try {
            const result = await PayslipService.getPayslipByPayrollId(req.params.payroll_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByNumber(req, res) {
        try {
            const result = await PayslipService.getPayslipByNumber(req.params.payslip_number);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByEmployee(req, res) {
        try {
            const result = await PayslipService.getPayslipsByEmployee(req.params.employee_id);
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
            const result = await PayslipService.getPayslipsByPeriod(req.params.payroll_period_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async updatePdfUrl(req, res) {
        try {
            const result = await PayslipService.updatePdfUrl(req.params.id, req.body.pdf_url);
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
            const result = await PayslipService.deletePayslip(req.params.id);
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

module.exports = PayslipController;