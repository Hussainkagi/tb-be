const LeaveRequestModel = require("../models/leaveRequestModel");
const LeaveTypeModel = require("../models/leaveTypeModel");
const EmployeeModel = require("../models/employeeModel");
const DepartmentModel = require("../models/departmentModel");
const NotificationService = require("./notificationService");

// ── Two-stage approval routing ───────────────────────────────────────────────
// A regular employee's leave goes to their head of department first, then to
// the admin. The head of department's own leave skips straight to the admin,
// and so does anyone whose department has no head (or who has no department).
async function resolveApprovalRoute(employee) {
    const department = employee.department_id
        ? await DepartmentModel.findById(employee.department_id)
        : null;

    const head_employee_id = department?.head_employee_id ?? null;
    const needsHod = Boolean(head_employee_id) && head_employee_id !== employee.id;

    return {
        department,
        department_id: employee.department_id ?? null,
        approval_stage: needsHod ? "hod" : "admin",
        hod_status: needsHod ? "pending" : "not_required",
        hod_employee_id: needsHod ? head_employee_id : null,
        // Why the HOD stage was skipped — surfaced to the UI so it can explain
        // "goes straight to admin" instead of looking like a missing step.
        skip_reason: needsHod
            ? null
            : !employee.department_id
                ? "employee_has_no_department"
                : !head_employee_id
                    ? "department_has_no_head"
                    : "employee_is_head_of_department",
    };
}

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
                is_half_day: _is_half_day = false,
                reason,
                document_url = null,
                document_file = null,
            } = data;

            const is_half_day = _is_half_day === true || _is_half_day === "true";

            let uploadedDocUrl = document_url;
            if (document_file) {
                try {
                    const { secureUrl } = await require("../utils/cloudinaryHelper").uploadToCloudinary(
                        document_file.buffer,
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

            // Decide who approves first — head of department or admin
            const route = await resolveApprovalRoute(employee);

            // Create the leave request
            const result = await LeaveRequestModel.create({
                ...data,
                document_url: uploadedDocUrl,
                department_id: route.department_id,
                approval_stage: route.approval_stage,
                hod_status: route.hod_status,
                hod_employee_id: route.hod_employee_id,
            });

            // ── Notify whoever must act first ────────────────────────────
            // Fire-and-forget: notification failure must NOT break leave creation
            const employee_name = `${employee.first_name} ${employee.last_name}`;

            if (route.approval_stage === "hod") {
                NotificationService.notifyLeaveRequestToHod({
                    company_id: employee.company_id,
                    hod_employee_id: route.hod_employee_id,
                    leave_id: result.id,
                    employee_name,
                    employee_code: employee.employee_code,
                    leave_type: leaveType.leave_name,
                    department_name: route.department?.department_name ?? "your department",
                    start_date: from_date,
                    end_date: to_date,
                }).catch((err) =>
                    console.error("[Notification] notifyLeaveRequestToHod failed:", err.message)
                );
            } else {
                NotificationService.notifyLeaveRequest({
                    company_id: employee.company_id,
                    branch_id: employee.branch_id,
                    leave_id: result.id,
                    employee_name,
                    employee_code: employee.employee_code,
                    leave_type: leaveType.leave_name,
                    start_date: from_date,
                    end_date: to_date,
                }).catch((err) =>
                    console.error("[Notification] notifyLeaveRequest failed:", err.message)
                );
            }

            return {
                success: true,
                message: route.approval_stage === "hod"
                    ? "Leave request submitted. Awaiting head of department approval."
                    : "Leave request submitted. Awaiting admin approval.",
                data: result,
                approval_route: {
                    approval_stage: route.approval_stage,
                    hod_employee_id: route.hod_employee_id,
                    department_name: route.department?.department_name ?? null,
                    skip_reason: route.skip_reason,
                },
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

    async getByCompanyAndStage(company_id, stage) {
        try {
            if (!["hod", "admin", "completed"].includes(stage)) {
                return {
                    success: false,
                    message: "Invalid stage. Must be one of: hod, admin, completed",
                };
            }

            const result = await LeaveRequestModel.getByCompanyAndStage(company_id, stage);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
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

    async approveLeaveRequest(id, approved_by, { override_hod = false } = {}) {
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

            // Stage one must clear first. An admin can force it through with
            // override_hod — used when the HOD is unavailable.
            if (leaveRequest.approval_stage === "hod" && !override_hod) {
                const hodName = leaveRequest.hod_first_name
                    ? `${leaveRequest.hod_first_name} ${leaveRequest.hod_last_name}`
                    : "the head of department";
                return {
                    success: false,
                    message: `This request is awaiting approval from ${hodName} (head of ${leaveRequest.department_name ?? "the department"}). Pass override_hod: true to approve it directly.`,
                    data: {
                        approval_stage: leaveRequest.approval_stage,
                        hod_employee_id: leaveRequest.hod_employee_id,
                        hod_status: leaveRequest.hod_status,
                    },
                };
            }

            const result = await LeaveRequestModel.approve(id, approved_by);
            const leaveType = await LeaveTypeModel.findById(leaveRequest.leave_type_id);
            // ── Notify employee their leave was approved ─────────────────
            NotificationService.notifyLeaveStatusUpdate({
                company_id: leaveRequest.company_id,
                employee_id: leaveRequest.employee_id,
                leave_id: id,
                status: "approved",
                leave_type: leaveType.leave_name,
                start_date: leaveRequest.from_date,
                end_date: leaveRequest.to_date,
                actioned_by: approved_by,
            }).catch((err) =>
                console.error("[Notification] notifyLeaveStatusUpdate (approved) failed:", err.message)
            );

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
            const leaveType = await LeaveTypeModel.findById(leaveRequest.leave_type_id);

            // ── Notify employee their leave was rejected ─────────────────
            NotificationService.notifyLeaveStatusUpdate({
                company_id: leaveRequest.company_id,
                employee_id: leaveRequest.employee_id,
                leave_id: id,
                status: "rejected",
                leave_type: leaveType.leave_name,
                start_date: leaveRequest.from_date,
                end_date: leaveRequest.to_date,
                actioned_by: approved_by,
                rejection_reason: rejection_reason,
            }).catch((err) =>
                console.error("[Notification] notifyLeaveStatusUpdate (rejected) failed:", err.message)
            );

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

    // --------------------------------------------------------
    // APPROVAL — head of department leg
    // --------------------------------------------------------

    // Resolves the requesting user to their employee record and the department
    // they head. Every HOD endpoint runs through this — the HOD is usually a
    // plain Employee role, so authorisation is identity-based, not role-based.
    async resolveHod(user_id, company_id) {
        const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
        if (!employee) {
            return { success: false, message: "No employee profile found for this user in this company" };
        }

        const department = await DepartmentModel.findByHeadEmployee(employee.id);
        if (!department) {
            return { success: false, message: "You are not head of any department" };
        }

        return { success: true, employee, department };
    },

    // The HOD's own queue. stage defaults to "hod" — the requests waiting on them.
    async getLeaveRequestsForHod(user_id, company_id, { stage = "hod", status = null } = {}) {
        try {
            const hod = await this.resolveHod(user_id, company_id);
            if (!hod.success) return hod;

            const requests = await LeaveRequestModel.getAllForHod(hod.employee.id, {
                stage: stage === "all" ? null : stage,
                status,
            });

            return {
                success: true,
                data: {
                    department: {
                        department_id: hod.department.id,
                        department_name: hod.department.department_name,
                    },
                    hod_employee_id: hod.employee.id,
                    pending_count: await LeaveRequestModel.countPendingForHod(hod.employee.id),
                    requests,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async hodApproveLeaveRequest(id, user_id, company_id) {
        try {
            const hod = await this.resolveHod(user_id, company_id);
            if (!hod.success) return hod;

            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return { success: false, message: "Leave request not found" };
            }

            if (leaveRequest.hod_employee_id !== hod.employee.id) {
                return { success: false, message: "You are not the head of department for this request" };
            }

            if (leaveRequest.status !== "pending" || leaveRequest.approval_stage !== "hod") {
                return {
                    success: false,
                    message: `This request is not awaiting your approval. Status: ${leaveRequest.status}, stage: ${leaveRequest.approval_stage}`,
                };
            }

            const result = await LeaveRequestModel.hodApprove(id, user_id);
            if (!result) {
                return { success: false, message: "This request is no longer awaiting head of department approval" };
            }

            const hod_name = `${hod.employee.first_name} ${hod.employee.last_name}`;
            const employee_name = `${leaveRequest.employee_first_name} ${leaveRequest.employee_last_name}`;

            // Hand the request over to the admin, and keep the employee informed
            NotificationService.notifyLeaveRequestToAdminAfterHod({
                company_id: leaveRequest.company_id,
                branch_id: leaveRequest.branch_id,
                leave_id: id,
                employee_name,
                employee_code: leaveRequest.employee_code,
                leave_type: leaveRequest.leave_name,
                department_name: leaveRequest.department_name ?? hod.department.department_name,
                hod_name,
                start_date: leaveRequest.from_date,
                end_date: leaveRequest.to_date,
            }).catch((err) =>
                console.error("[Notification] notifyLeaveRequestToAdminAfterHod failed:", err.message)
            );

            NotificationService.notifyLeaveHodApproved({
                company_id: leaveRequest.company_id,
                employee_id: leaveRequest.employee_id,
                leave_id: id,
                leave_type: leaveRequest.leave_name,
                hod_name,
                start_date: leaveRequest.from_date,
                end_date: leaveRequest.to_date,
            }).catch((err) =>
                console.error("[Notification] notifyLeaveHodApproved failed:", err.message)
            );

            return {
                success: true,
                message: "Leave request approved by head of department. Awaiting admin approval.",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async hodRejectLeaveRequest(id, user_id, company_id, rejection_reason) {
        try {
            if (!rejection_reason || rejection_reason.trim() === "") {
                return { success: false, message: "rejection_reason is required when rejecting a leave request" };
            }

            const hod = await this.resolveHod(user_id, company_id);
            if (!hod.success) return hod;

            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return { success: false, message: "Leave request not found" };
            }

            if (leaveRequest.hod_employee_id !== hod.employee.id) {
                return { success: false, message: "You are not the head of department for this request" };
            }

            if (leaveRequest.status !== "pending" || leaveRequest.approval_stage !== "hod") {
                return {
                    success: false,
                    message: `This request is not awaiting your approval. Status: ${leaveRequest.status}, stage: ${leaveRequest.approval_stage}`,
                };
            }

            const result = await LeaveRequestModel.hodReject(id, user_id, rejection_reason);
            if (!result) {
                return { success: false, message: "This request is no longer awaiting head of department approval" };
            }

            // Rejected at stage one — the admin never sees it, the employee does
            NotificationService.notifyLeaveStatusUpdate({
                company_id: leaveRequest.company_id,
                employee_id: leaveRequest.employee_id,
                leave_id: id,
                status: "rejected",
                leave_type: leaveRequest.leave_name,
                start_date: leaveRequest.from_date,
                end_date: leaveRequest.to_date,
                actioned_by: user_id,
                rejection_reason,
            }).catch((err) =>
                console.error("[Notification] notifyLeaveStatusUpdate (hod rejected) failed:", err.message)
            );

            return {
                success: true,
                message: "Leave request rejected by head of department",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // Lets the frontend decide what to render before anything is submitted:
    // does this employee's leave need HOD approval, and is this user a HOD?
    async getApprovalRouteForEmployee(employee_id, user_id = null, company_id = null) {
        try {
            const employee = await EmployeeModel.findById(employee_id);
            if (!employee) {
                return { success: false, message: "Employee not found" };
            }

            const route = await resolveApprovalRoute(employee);

            let is_head_of_department = false;
            if (user_id && company_id) {
                const hod = await this.resolveHod(user_id, company_id);
                is_head_of_department = hod.success;
            }

            return {
                success: true,
                data: {
                    employee_id,
                    department_id: route.department_id,
                    department_name: route.department?.department_name ?? null,
                    requires_hod_approval: route.approval_stage === "hod",
                    approval_stage: route.approval_stage,
                    hod_employee_id: route.hod_employee_id,
                    hod_name: route.department?.head_first_name
                        ? `${route.department.head_first_name} ${route.department.head_last_name}`
                        : null,
                    skip_reason: route.skip_reason,
                    is_head_of_department,
                    approval_chain: route.approval_stage === "hod"
                        ? ["head_of_department", "admin"]
                        : ["admin"],
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // --------------------------------------------------------
    // The rest of the methods are unchanged
    // --------------------------------------------------------

    async cancelLeaveRequest(id, employee_id) {
        try {
            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return {
                    success: false,
                    message: "Leave request not found",
                };
            }

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

    async updateLeaveRequest(id, employee_id, data) {
        try {
            const leaveRequest = await LeaveRequestModel.findById(id);
            if (!leaveRequest) {
                return {
                    success: false,
                    message: "Leave request not found",
                };
            }

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
                    id
                );
                if (overlapping.length > 0) {
                    return {
                        success: false,
                        message: "Updated dates overlap with another pending or approved leave request",
                    };
                }
            }

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