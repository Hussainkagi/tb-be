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
            const result = await PayslipService.getPayslipByNumber(req.params.payslip_number, {
                user: req.user, company_id: req.params.company_id,
            });
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
            const result = await PayslipService.getPayslipsByEmployee(req.params.employee_id, {
                user: req.user, company_id: req.params.company_id,
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

    // ============================================================
    // EMPLOYEE SELF-SERVICE (mobile app)
    // The employee comes from the token — never from the URL.
    // ============================================================

    // GET /api/companies/:company_id/payslips/my?year=2026&month=8
    async getMine(req, res) {
        try {
            const result = await PayslipService.getMyPayslips({
                company_id: req.params.company_id,
                user: req.user,
                year: req.query.year || null,
                month: req.query.month || null,
            });
            return result.success
                ? res.status(200).json(result)
                : res.status(result.status || 400).json({ success: false, message: result.message });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // GET /api/companies/:company_id/payslips/my/available
    async getMineAvailable(req, res) {
        try {
            const result = await PayslipService.getMyPayslipYears({
                company_id: req.params.company_id,
                user: req.user,
            });
            return result.success
                ? res.status(200).json(result)
                : res.status(result.status || 400).json({ success: false, message: result.message });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // GET /api/companies/:company_id/payslips/my/:id
    async getMineById(req, res) {
        try {
            const result = await PayslipService.getMyPayslipById({
                company_id: req.params.company_id,
                user: req.user,
                payslip_id: req.params.id,
            });
            return result.success
                ? res.status(200).json(result)
                : res.status(result.status || 404).json({ success: false, message: result.message });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = PayslipController;