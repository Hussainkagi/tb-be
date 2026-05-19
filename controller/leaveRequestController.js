const LeaveRequestService = require("../service/leaveRequestService");

const LeaveRequestController = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    // POST /api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests
    async create(req, res) {
        try {
            const result = await LeaveRequestService.createLeaveRequest({
                ...req.body,
                company_id: req.params.company_id,
                branch_id: req.params.branch_id,
                employee_id: req.params.employee_id,
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

    // GET /api/leave-requests/:id
    async getById(req, res) {
        try {
            const result = await LeaveRequestService.getLeaveRequestById(
                req.params.id
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
    // READ — employee scope
    // --------------------------------------------------------

    // GET /api/employees/:employee_id/leave-requests
    async getAllByEmployee(req, res) {
        try {
            const result = await LeaveRequestService.getAllByEmployee(
                req.params.employee_id
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

    // GET /api/employees/:employee_id/leave-requests/status/:status
    async getByEmployeeAndStatus(req, res) {
        try {
            const result = await LeaveRequestService.getByEmployeeAndStatus(
                req.params.employee_id,
                req.params.status
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

    // GET /api/branches/:branch_id/leave-requests
    async getAllByBranch(req, res) {
        try {
            const result = await LeaveRequestService.getAllByBranch(
                req.params.branch_id
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

    // GET /api/branches/:branch_id/leave-requests/status/:status
    async getByBranchAndStatus(req, res) {
        try {
            const result = await LeaveRequestService.getByBranchAndStatus(
                req.params.branch_id,
                req.params.status
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
    // READ — company scope
    // --------------------------------------------------------

    // GET /api/companies/:company_id/leave-requests
    async getAllByCompany(req, res) {
        try {
            const result = await LeaveRequestService.getAllByCompany(
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

    // GET /api/companies/:company_id/leave-requests/status/:status
    async getByCompanyAndStatus(req, res) {
        try {
            const result = await LeaveRequestService.getByCompanyAndStatus(
                req.params.company_id,
                req.params.status
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
    // READ — date range (payroll / reporting)
    // --------------------------------------------------------

    // GET /api/companies/:company_id/leave-requests/date-range
    // Query params: from_date, to_date, branch_id (optional)
    async getByDateRange(req, res) {
        try {
            const { from_date, to_date, branch_id } = req.query;

            if (!from_date || !to_date) {
                return res.status(400).json({
                    success: false,
                    message: "from_date and to_date are required query parameters",
                });
            }

            const result = await LeaveRequestService.getByDateRange(
                req.params.company_id,
                from_date,
                to_date,
                branch_id ?? null
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
    // UPDATE — approval workflow
    // --------------------------------------------------------

    // PATCH /api/leave-requests/:id/approve
    async approve(req, res) {
        try {
            const result = await LeaveRequestService.approveLeaveRequest(
                req.params.id,
                req.body.approved_by
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

    // PATCH /api/leave-requests/:id/reject
    async reject(req, res) {
        try {
            const result = await LeaveRequestService.rejectLeaveRequest(
                req.params.id,
                req.body.approved_by,
                req.body.rejection_reason
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

    // PATCH /api/leave-requests/:id/cancel
    async cancel(req, res) {
        try {
            const result = await LeaveRequestService.cancelLeaveRequest(
                req.params.id,
                req.body.employee_id
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
    // UPDATE — general field update (only while pending)
    // --------------------------------------------------------

    // PUT /api/leave-requests/:id
    async update(req, res) {
        try {
            const result = await LeaveRequestService.updateLeaveRequest(
                req.params.id,
                req.body.employee_id,
                req.body
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
    // DELETE — soft delete
    // --------------------------------------------------------

    // DELETE /api/leave-requests/:id
    async delete(req, res) {
        try {
            const result = await LeaveRequestService.deleteLeaveRequest(
                req.params.id
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
};

module.exports = LeaveRequestController;