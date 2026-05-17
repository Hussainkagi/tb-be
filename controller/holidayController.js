const HolidayService = require("../service/holidayService");

const HolidayController = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async create(req, res) {
        try {
            const result = await HolidayService.createHoliday({
                ...req.body,
                company_id: req.params.company_id,
            });
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // --------------------------------------------------------
    // READ — single record
    // --------------------------------------------------------

    async getById(req, res) {
        try {
            const result = await HolidayService.getHolidayById(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // --------------------------------------------------------
    // READ — company scope
    // --------------------------------------------------------

    // GET /companies/:company_id/holidays
    async getAllByCompany(req, res) {
        try {
            const result = await HolidayService.getAllByCompany(req.params.company_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // GET /companies/:company_id/holidays/company-wide
    async getCompanyWide(req, res) {
        try {
            const result = await HolidayService.getCompanyWideHolidays(
                req.params.company_id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // --------------------------------------------------------
    // READ — branch scope
    // --------------------------------------------------------

    // GET /companies/:company_id/branches/:branch_id/holidays
    // Returns company-wide + branch-specific merged — main employee-facing API
    async getAllByBranch(req, res) {
        try {
            const result = await HolidayService.getAllByBranch(
                req.params.company_id,
                req.params.branch_id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // GET /companies/:company_id/branches/:branch_id/holidays/branch-only
    async getBranchSpecific(req, res) {
        try {
            const result = await HolidayService.getBranchSpecificHolidays(
                req.params.company_id,
                req.params.branch_id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // --------------------------------------------------------
    // READ — date / attendance helpers
    // --------------------------------------------------------

    // GET /companies/:company_id/branches/:branch_id/holidays/check?date=2025-12-25
    async checkIsHoliday(req, res) {
        try {
            const { date } = req.query;

            if (!date) {
                return res.status(400).json({
                    success: false,
                    message: "Query param 'date' is required (YYYY-MM-DD)",
                });
            }

            const result = await HolidayService.checkIsHoliday(
                req.params.company_id,
                req.params.branch_id,
                date
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // GET /companies/:company_id/branches/:branch_id/holidays/range?from=2025-01-01&to=2025-12-31
    async getByDateRange(req, res) {
        try {
            const { from, to } = req.query;

            if (!from || !to) {
                return res.status(400).json({
                    success: false,
                    message: "Query params 'from' and 'to' are required (YYYY-MM-DD)",
                });
            }

            const result = await HolidayService.getHolidaysByDateRange(
                req.params.company_id,
                req.params.branch_id,
                from,
                to
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // --------------------------------------------------------
    // UPDATE
    // --------------------------------------------------------

    async update(req, res) {
        try {
            const result = await HolidayService.updateHoliday(req.params.id, req.body);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    async deactivate(req, res) {
        try {
            const result = await HolidayService.deactivateHoliday(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    async activate(req, res) {
        try {
            const result = await HolidayService.activateHoliday(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // --------------------------------------------------------
    // DELETE — soft delete
    // --------------------------------------------------------

    async delete(req, res) {
        try {
            const result = await HolidayService.deleteHoliday(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },
};

module.exports = HolidayController;