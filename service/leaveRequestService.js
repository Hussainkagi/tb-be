const LeaveRequestModel = require("../models/leaveRequestModel");
const LeaveTypeModel = require("../models/leaveTypeModel");
const EmployeeModel = require("../models/employeeModel");


const LeaveRequestService = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------


    async createLeaveRequest(data) {
        try {
            const {
                employee_id,
                leave_type_id,
                from_date,
                to_date,
                total_days,
                is_half_day = false,
                reason,
                document_url = null,
                document_file = null, // multer file object from req.file
            } = data;

            // Upload document to Cloudinary if provided
            let uploadedDocUrl = document_url;
            if (document_file) {
                try {
                    const { secureUrl } = await require("../utils/cloudinaryHelper").uploadToCloudinary(
                        document_file.buffer, // 👈 pass only the Buffer, not the whole multer object
                        {
                            folder: `leave/documents/${employee_id}`,
                            resourceType: "auto",
                        }
                    );
                    uploadedDocUrl = secureUrl;
                } catch (err) {
                    return {
                        success: false,
                        message: "Document upload failed",
                        error: err.message,
                    };
                }
            }

            // Verify employee exists
            const employee = await EmployeeModel.findById(employee_id);
            if (!employee) {
                return { success: false, message: "Employee not found" };
            }

            // Verify leave type exists and is active
            const leaveType = await LeaveTypeModel.findById(leave_type_id);
            if (!leaveType) {
                return { success: false, message: "Leave type not found" };
            }
            if (!leaveType.is_active) {
                return { success: false, message: "The selected leave type is not active" };
            }

            // Half-day validation
            if (is_half_day) {
                if (!leaveType.is_half_day_allowed) {
                    return { success: false, message: "Half-day leave is not allowed for this leave type" };
                }
                if (from_date !== to_date) {
                    return { success: false, message: "Half-day leave must be a single-day request (from_date must equal to_date)" };
                }
            }

            // Document validation
            if (leaveType.requires_document && !uploadedDocUrl) {
                return { success: false, message: "A supporting document is required for this leave type" };
            }

            // Date range validation
            if (new Date(to_date) < new Date(from_date)) {
                return { success: false, message: "to_date must be on or after from_date" };
            }

            // Total days validation
            if (!total_days || total_days <= 0) {
                return { success: false, message: "total_days must be greater than 0" };
            }

            // Overlapping leave check
            const overlapping = await LeaveRequestModel.getOverlapping(employee_id, from_date, to_date);
            if (overlapping.length > 0) {
                return { success: false, message: "Employee already has a pending or approved leave request overlapping these dates" };
            }

            const result = await LeaveRequestModel.create({
                ...data,
                document_url: uploadedDocUrl,
            });

            return {
                success: true,
                message: "Leave request created successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // READ — single record
    // --------------------------------------------------------

    async getLeaveRequestById(id) {
        try {
            const result = await LeaveRequestModel.findById(id);
            if (!result) {
                return {
                    success: false,
                    message: "Leave request not found",
                };
            }
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // READ — employee scope
    // --------------------------------------------------------

    async getAllByEmployee(employee_id) {
        try {
            const result = await LeaveRequestModel.getAllByEmployee(employee_id);
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getByEmployeeAndStatus(employee_id, status) {
        try {
            if (!isValidStatus(status)) {
                return {
                    success: false,
                    message: `Invalid status. Must be one of: pending, approved, rejected, cancelled`,
                };
            }

            const result = await LeaveRequestModel.getByEmployeeAndStatus(employee_id, status);
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // READ — branch scope
    // --------------------------------------------------------

    async getAllByBranch(branch_id) {
        try {
            const result = await LeaveRequestModel.getAllByBranch(branch_id);
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getByBranchAndStatus(branch_id, status) {
        try {
            if (!isValidStatus(status)) {
                return {
                    success: false,
                    message: `Invalid status. Must be one of: pending, approved, rejected, cancelled`,
                };
            }

            const result = await LeaveRequestModel.getByBranchAndStatus(branch_id, status);
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // READ — company scope
    // --------------------------------------------------------

    async getAllByCompany(company_id) {
        try {
            const result = await LeaveRequestModel.getAllByCompany(company_id);
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async getByCompanyAndStatus(company_id, status) {
        try {
            if (!isValidStatus(status)) {
                return {
                    success: false,
                    message: `Invalid status. Must be one of: pending, approved, rejected, cancelled`,
                };
            }

            const result = await LeaveRequestModel.getByCompanyAndStatus(company_id, status);
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // READ — date range (payroll / reporting)
    // --------------------------------------------------------

    async getByDateRange(company_id, from_date, to_date, branch_id = null) {
        try {
            if (new Date(to_date) < new Date(from_date)) {
                return {
                    success: false,
                    message: "to_date must be on or after from_date",
                };
            }

            const result = await LeaveRequestModel.getByDateRange(
                company_id,
                from_date,
                to_date,
                branch_id
            );
            return {
                success: true,
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // UPDATE — approval workflow
    // --------------------------------------------------------

    async approveLeaveRequest(id, approved_by) {
        try {
            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return {
                    success: false,
                    message: "Leave request not found",
                };
            }

            if (leaveRequest.status !== "pending") {
                return {
                    success: false,
                    message: `Only pending leave requests can be approved. Current status: ${leaveRequest.status}`,
                };
            }

            const result = await LeaveRequestModel.approve(id, approved_by);
            return {
                success: true,
                message: "Leave request approved successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async rejectLeaveRequest(id, approved_by, rejection_reason) {
        try {
            if (!rejection_reason || rejection_reason.trim() === "") {
                return {
                    success: false,
                    message: "rejection_reason is required when rejecting a leave request",
                };
            }

            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return {
                    success: false,
                    message: "Leave request not found",
                };
            }

            if (leaveRequest.status !== "pending") {
                return {
                    success: false,
                    message: `Only pending leave requests can be rejected. Current status: ${leaveRequest.status}`,
                };
            }

            const result = await LeaveRequestModel.reject(id, approved_by, rejection_reason);
            return {
                success: true,
                message: "Leave request rejected successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async cancelLeaveRequest(id, employee_id) {
        try {
            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return {
                    success: false,
                    message: "Leave request not found",
                };
            }

            // Only the owning employee can cancel their request
            if (leaveRequest.employee_id !== employee_id) {
                return {
                    success: false,
                    message: "You are not authorized to cancel this leave request",
                };
            }

            if (!["pending", "approved"].includes(leaveRequest.status)) {
                return {
                    success: false,
                    message: `Leave request cannot be cancelled. Current status: ${leaveRequest.status}`,
                };
            }

            const result = await LeaveRequestModel.cancel(id);
            return {
                success: true,
                message: "Leave request cancelled successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // UPDATE — general field update (only while pending)
    // --------------------------------------------------------

    async updateLeaveRequest(id, employee_id, data) {
        try {
            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return {
                    success: false,
                    message: "Leave request not found",
                };
            }

            // Only the owning employee can edit their request
            if (leaveRequest.employee_id !== employee_id) {
                return {
                    success: false,
                    message: "You are not authorized to update this leave request",
                };
            }

            if (leaveRequest.status !== "pending") {
                return {
                    success: false,
                    message: `Only pending leave requests can be edited. Current status: ${leaveRequest.status}`,
                };
            }

            // If dates are being updated, re-run overlap check (excluding this request)
            const from_date = data.from_date ?? leaveRequest.from_date;
            const to_date = data.to_date ?? leaveRequest.to_date;

            if (data.from_date || data.to_date) {
                if (new Date(to_date) < new Date(from_date)) {
                    return {
                        success: false,
                        message: "to_date must be on or after from_date",
                    };
                }

                const overlapping = await LeaveRequestModel.getOverlapping(
                    leaveRequest.employee_id,
                    from_date,
                    to_date,
                    id   // exclude current record
                );
                if (overlapping.length > 0) {
                    return {
                        success: false,
                        message: "Updated dates overlap with another pending or approved leave request",
                    };
                }
            }

            // Document validation if leave type requires it
            const document_url = data.document_url ?? leaveRequest.document_url;
            if (leaveRequest.requires_document && !document_url) {
                return {
                    success: false,
                    message: "A supporting document is required for this leave type",
                };
            }

            const result = await LeaveRequestModel.update(id, data);
            return {
                success: true,
                message: "Leave request updated successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // DELETE — soft delete
    // --------------------------------------------------------

    async deleteLeaveRequest(id) {
        try {
            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return {
                    success: false,
                    message: "Leave request not found",
                };
            }

            if (leaveRequest.status === "approved") {
                return {
                    success: false,
                    message: "Approved leave requests cannot be deleted. Cancel it first.",
                };
            }

            const result = await LeaveRequestModel.delete(id);
            return {
                success: true,
                message: "Leave request deleted successfully",
                data: result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },
};

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function isValidStatus(status) {
    return ["pending", "approved", "rejected", "cancelled"].includes(status);
}

module.exports = LeaveRequestService;