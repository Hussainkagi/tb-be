const LeaveTypeModel = require("../models/leaveTypeModel");
const CompanyModel = require("../models/companyModel");

const LeaveTypeService = {
    // --------------------------------------------------------
    // READ — onboarding check
    // --------------------------------------------------------

    async checkLeaveTypesExist(company_id) {
        try {
            const exists = await LeaveTypeModel.hasLeaveTypes(company_id);
            return {
                success: true,
                data: { has_leave_types: exists },
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
    // CREATE — seed defaults (admin action)
    // --------------------------------------------------------

    async seedDefaultLeaveTypes(company_id) {
        try {
            // Verify company exists
            const company = await CompanyModel.findById(company_id);
            if (!company) {
                return {
                    success: false,
                    message: "Company not found",
                };
            }

            const result = await LeaveTypeModel.seedDefaults(company_id);

            return {
                success: true,
                message: `${result.length} default leave types created successfully`,
                data: result,
            };
        } catch (error) {
            // Unique constraint: leave_name already exists for this company
            if (error.code === "23505") {
                return {
                    success: false,
                    message:
                        "One or more default leave types already exist for this company. Remove existing ones before seeding defaults.",
                };
            }
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async createLeaveType(data) {
        try {
            const { company_id, leave_name, total_days, is_carry_forward, max_carry_forward_days } = data;

            // Verify company exists
            const company = await CompanyModel.findById(company_id);
            if (!company) {
                return {
                    success: false,
                    message: "Company not found",
                };
            }

            // Validate total_days
            if (!total_days || total_days <= 0) {
                return {
                    success: false,
                    message: "total_days must be greater than 0",
                };
            }

            // Carry forward consistency:
            // max_carry_forward_days should only be set when is_carry_forward is true
            if (!is_carry_forward && max_carry_forward_days != null) {
                return {
                    success: false,
                    message: "max_carry_forward_days can only be set when is_carry_forward is true",
                };
            }

            const result = await LeaveTypeModel.create(data);

            return {
                success: true,
                message: "Leave type created successfully",
                data: result,
            };
        } catch (error) {
            // Unique constraint: same leave_name already exists for this company
            if (error.code === "23505") {
                return {
                    success: false,
                    message: `A leave type named "${data.leave_name}" already exists for this company`,
                };
            }
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

    async getLeaveTypeById(id) {
        try {
            const result = await LeaveTypeModel.findById(id);
            if (!result) {
                return {
                    success: false,
                    message: "Leave type not found",
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
    // READ — company scope
    // --------------------------------------------------------

    async getAllByCompany(company_id) {
        try {
            const result = await LeaveTypeModel.getAllByCompany(company_id);
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

    async getActiveByCompany(company_id) {
        try {
            const result = await LeaveTypeModel.getActiveByCompany(company_id);
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

    async getPaidLeaveTypes(company_id) {
        try {
            const result = await LeaveTypeModel.getPaidByCompany(company_id);
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

    async getUnpaidLeaveTypes(company_id) {
        try {
            const result = await LeaveTypeModel.getUnpaidByCompany(company_id);
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

    async getCarryForwardLeaveTypes(company_id) {
        try {
            const result = await LeaveTypeModel.getCarryForwardByCompany(company_id);
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
    // UPDATE
    // --------------------------------------------------------

    async updateLeaveType(id, data) {
        try {
            // Carry forward consistency check on update
            const { is_carry_forward, max_carry_forward_days, total_days } = data;

            if (total_days !== undefined && total_days <= 0) {
                return {
                    success: false,
                    message: "total_days must be greater than 0",
                };
            }

            if (is_carry_forward === false && max_carry_forward_days != null) {
                return {
                    success: false,
                    message: "max_carry_forward_days can only be set when is_carry_forward is true",
                };
            }

            // If only max_carry_forward_days is being updated, verify existing record allows it
            if (max_carry_forward_days !== undefined && is_carry_forward === undefined) {
                const existing = await LeaveTypeModel.findById(id);
                if (!existing) {
                    return {
                        success: false,
                        message: "Leave type not found",
                    };
                }
                if (!existing.is_carry_forward && max_carry_forward_days != null) {
                    return {
                        success: false,
                        message: "max_carry_forward_days can only be set when is_carry_forward is true",
                    };
                }
            }

            const result = await LeaveTypeModel.update(id, data);
            if (!result) {
                return {
                    success: false,
                    message: "Leave type not found",
                };
            }
            return {
                success: true,
                message: "Leave type updated successfully",
                data: result,
            };
        } catch (error) {
            if (error.code === "23505") {
                return {
                    success: false,
                    message: `A leave type named "${data.leave_name}" already exists for this company`,
                };
            }
            return {
                success: false,
                message: error.message,
                error: error,
            };
        }
    },

    async deactivateLeaveType(id) {
        try {
            const result = await LeaveTypeModel.deactivate(id);
            if (!result) {
                return {
                    success: false,
                    message: "Leave type not found",
                };
            }
            return {
                success: true,
                message: "Leave type deactivated successfully",
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

    async activateLeaveType(id) {
        try {
            const result = await LeaveTypeModel.activate(id);
            if (!result) {
                return {
                    success: false,
                    message: "Leave type not found",
                };
            }
            return {
                success: true,
                message: "Leave type activated successfully",
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

    async deleteLeaveType(id) {
        try {
            const result = await LeaveTypeModel.delete(id);
            if (!result) {
                return {
                    success: false,
                    message: "Leave type not found",
                };
            }
            return {
                success: true,
                message: "Leave type deleted successfully",
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

module.exports = LeaveTypeService;