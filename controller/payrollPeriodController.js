const PayrollPeriodService = require("../service/payrollPeriodService");

const PayrollPeriodController = {

    async create(req, res) {
        try {
            // company_id comes from the route, not the body — the router is
            // mounted under /companies/:company_id and the tenant guard has
            // already validated it. payrollRunController does the same; making
            // the client repeat it in the body invites the two disagreeing.
            const result = await PayrollPeriodService.createPayrollPeriod({
                ...req.body,
                company_id: req.params.company_id,
            });
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
            const result = await PayrollPeriodService.getPayrollPeriodById(req.params.id);
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
            const result = await PayrollPeriodService.getPayrollPeriodsByCompany(req.params.company_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByStatus(req, res) {
        try {
            const result = await PayrollPeriodService.getPayrollPeriodsByStatus(
                req.params.company_id,
                req.params.status
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

    async getByDateRange(req, res) {
        try {
            const { company_id } = req.params;
            const { start_date, end_date } = req.query;
            const result = await PayrollPeriodService.getPayrollPeriodsByDateRange(
                company_id,
                start_date,
                end_date
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

    async update(req, res) {
        try {
            const result = await PayrollPeriodService.updatePayrollPeriod(req.params.id, req.body);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async updateStatus(req, res) {
        try {
            const result = await PayrollPeriodService.updatePayrollPeriodStatus(
                req.params.id,
                req.body.status
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

    async markAsProcessed(req, res) {
        try {
            const result = await PayrollPeriodService.markAsProcessed(
                req.params.id,
                req.body.processed_by
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

    async lock(req, res) {
        try {
            const result = await PayrollPeriodService.lockPayrollPeriod(req.params.id);
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
            const result = await PayrollPeriodService.deletePayrollPeriod(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // GET /api/companies/:company_id/payroll-periods/:id/deletion-preview
    // Powers the confirmation dialog: what would go, and may it go at all.
    async deletionPreview(req, res) {
        try {
            const result = await PayrollPeriodService.getDeletionPreview(req.params.id);
            return result.success
                ? res.status(200).json(result)
                : res.status(result.status || 400).json({ success: false, message: result.message });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = PayrollPeriodController;