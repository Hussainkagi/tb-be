const LeaveTypeService = require("../service/leaveTypeService");

const LeaveTypeController = {
    // --------------------------------------------------------
    // READ — onboarding check
    // --------------------------------------------------------

    // GET /api/companies/:company_id/leave-types/has-defaults
    async checkLeaveTypesExist(req, res) {
        try {
            const result = await LeaveTypeService.checkLeaveTypesExist(
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
    // CREATE — seed defaults (admin action)
    // --------------------------------------------------------

    // POST /companies/:company_id/leave-types/seed-defaults
    async seedDefaults(req, res) {
        try {
            const result = await LeaveTypeService.seedDefaultLeaveTypes(
                req.params.company_id
            );
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
    // CREATE
    // --------------------------------------------------------

    // POST /companies/:company_id/leave-types
    async create(req, res) {
        try {
            const result = await LeaveTypeService.createLeaveType({
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

    // GET /leave-types/:id
    async getById(req, res) {
        try {
            const result = await LeaveTypeService.getLeaveTypeById(req.params.id);
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

    // GET /companies/:company_id/leave-types
    async getAllByCompany(req, res) {
        try {
            const result = await LeaveTypeService.getAllByCompany(
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

    // GET /companies/:company_id/leave-types/active
    async getActive(req, res) {
        try {
            const result = await LeaveTypeService.getActiveByCompany(
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

    // GET /companies/:company_id/leave-types/paid
    async getPaid(req, res) {
        try {
            const result = await LeaveTypeService.getPaidLeaveTypes(
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

    // GET /companies/:company_id/leave-types/unpaid
    async getUnpaid(req, res) {
        try {
            const result = await LeaveTypeService.getUnpaidLeaveTypes(
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

    // GET /companies/:company_id/leave-types/carry-forward
    async getCarryForward(req, res) {
        try {
            const result = await LeaveTypeService.getCarryForwardLeaveTypes(
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
    // UPDATE
    // --------------------------------------------------------

    // PUT /leave-types/:id
    async update(req, res) {
        try {
            const result = await LeaveTypeService.updateLeaveType(
                req.params.id,
                req.body
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

    // PATCH /leave-types/:id/activate
    async activate(req, res) {
        try {
            const result = await LeaveTypeService.activateLeaveType(req.params.id);
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

    // PATCH /leave-types/:id/deactivate
    async deactivate(req, res) {
        try {
            const result = await LeaveTypeService.deactivateLeaveType(req.params.id);
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

    // DELETE /leave-types/:id
    async delete(req, res) {
        try {
            const result = await LeaveTypeService.deleteLeaveType(req.params.id);
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

module.exports = LeaveTypeController;