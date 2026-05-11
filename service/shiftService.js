const ShiftModel = require("../models/shiftModel");
const CompanyModel = require("../models/companyModel");
const BranchModel = require("../models/branchModel");

const ShiftService = {
    async createShift(data) {
        try {
            const { company_id, branch_id, shift_name } = data;

            // 1. Verify company exists and is active
            const company = await CompanyModel.findById(company_id);
            if (!company || !company.is_active) {
                return { success: false, message: "Company not found or inactive" };
            }

            // 2. Verify branch exists and belongs to the company
            const branch = await BranchModel.findById(branch_id);
            if (!branch || branch.company_id !== company_id) {
                return { success: false, message: "Branch not found or does not belong to this company" };
            }

            // 3. Check shift_name unique within branch
            const existing = await ShiftModel.findByName(company_id, branch_id, shift_name);
            if (existing) {
                return { success: false, message: "Shift name already exists in this branch" };
            }

            const result = await ShiftModel.create(data);
            return {
                success: true,
                message: "Shift created successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getShiftById(id) {
        try {
            const result = await ShiftModel.findById(id);
            if (!result) {
                return { success: false, message: "Shift not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getShiftsByCompany(company_id) {
        try {
            const result = await ShiftModel.findAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getShiftsByBranch(company_id, branch_id) {
        try {
            const result = await ShiftModel.findAllByBranch(company_id, branch_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // Called by attendance service to get shift timing data
    async getShiftTiming(shift_id) {
        try {
            const result = await ShiftModel.findTiming(shift_id);
            if (!result) {
                return { success: false, message: "Shift not found or inactive" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateShift(id, data) {
        try {
            // Prevent company_id and branch_id from being changed
            delete data.company_id;
            delete data.branch_id;

            // If shift_name is being updated, check uniqueness
            if (data.shift_name) {
                const shift = await ShiftModel.findById(id);
                if (!shift) {
                    return { success: false, message: "Shift not found" };
                }
                const existing = await ShiftModel.findByName(
                    shift.company_id,
                    shift.branch_id,
                    data.shift_name
                );
                if (existing && existing.id !== id) {
                    return { success: false, message: "Shift name already exists in this branch" };
                }
            }

            const result = await ShiftModel.update(id, data);
            if (!result) {
                return { success: false, message: "Shift not found" };
            }
            return {
                success: true,
                message: "Shift updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateShift(id) {
        try {
            const result = await ShiftModel.deactivate(id);
            if (!result) {
                return { success: false, message: "Shift not found" };
            }
            return {
                success: true,
                message: "Shift deactivated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteShift(id) {
        try {
            const result = await ShiftModel.delete(id);
            if (!result) {
                return { success: false, message: "Shift not found" };
            }
            return {
                success: true,
                message: "Shift deleted successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = ShiftService;