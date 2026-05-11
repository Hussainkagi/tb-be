const BranchModel = require("../models/branchModel");
const CompanyModel = require("../models/companyModel");

const BranchService = {
    async createBranch(data) {
        try {
            const { company_id, branch_code, latitude, longitude, is_head_office } = data;

            // 1. Verify company exists and is active
            const company = await CompanyModel.findById(company_id);
            if (!company || !company.is_active) {
                return { success: false, message: "Company not found or inactive" };
            }

            // 2. Check branch_code unique within company
            const existing = await BranchModel.findByCode(company_id, branch_code);
            if (existing) {
                return { success: false, message: "Branch code already exists in this company" };
            }

            // 3. Warn if lat/long missing (attendance geofence won't work without it)
            if (!latitude || !longitude) {
                console.warn(`[Branch] Branch "${data.branch_name}" created without lat/long — geofence check-in will not work`);
            }

            const result = await BranchModel.create(data);
            return {
                success: true,
                message: "Branch created successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getBranchById(id) {
        try {
            const result = await BranchModel.findById(id);
            if (!result) {
                return { success: false, message: "Branch not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getBranchesByCompany(company_id) {
        try {
            const result = await BranchModel.findAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // Called by attendance service to get geofence data
    async getBranchGeofence(branch_id) {
        try {
            const result = await BranchModel.findGeofence(branch_id);
            if (!result) {
                return { success: false, message: "Branch not found or inactive" };
            }
            if (!result.latitude || !result.longitude) {
                return { success: false, message: "Branch location not configured. Cannot verify check-in." };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateBranch(id, data) {
        try {
            // Prevent company_id from being changed
            delete data.company_id;

            // If branch_code is being updated, check uniqueness
            if (data.branch_code) {
                const branch = await BranchModel.findById(id);
                if (!branch) {
                    return { success: false, message: "Branch not found" };
                }
                const existing = await BranchModel.findByCode(branch.company_id, data.branch_code);
                if (existing && existing.id !== id) {
                    return { success: false, message: "Branch code already exists in this company" };
                }
            }

            const result = await BranchModel.update(id, data);
            if (!result) {
                return { success: false, message: "Branch not found" };
            }
            return {
                success: true,
                message: "Branch updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateBranch(id) {
        try {
            const result = await BranchModel.deactivate(id);
            if (!result) {
                return { success: false, message: "Branch not found" };
            }
            return {
                success: true,
                message: "Branch deactivated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteBranch(id) {
        try {
            const result = await BranchModel.delete(id);
            if (!result) {
                return { success: false, message: "Branch not found" };
            }
            return {
                success: true,
                message: "Branch deleted successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = BranchService;