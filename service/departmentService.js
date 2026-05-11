const DepartmentModel = require("../models/departmentModel");
const CompanyModel = require("../models/companyModel");
const BranchModel = require("../models/branchModel");

const DepartmentService = {
    async createDepartment(data) {
        try {
            const { company_id, branch_id, department_name } = data;

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

            // 3. Check department_name unique within branch
            const existing = await DepartmentModel.findByName(company_id, branch_id, department_name);
            if (existing) {
                return { success: false, message: "Department name already exists in this branch" };
            }

            const result = await DepartmentModel.create(data);
            return {
                success: true,
                message: "Department created successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDepartmentById(id) {
        try {
            const result = await DepartmentModel.findById(id);
            if (!result) {
                return { success: false, message: "Department not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDepartmentsByCompany(company_id) {
        try {
            const result = await DepartmentModel.findAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getDepartmentsByBranch(company_id, branch_id) {
        try {
            const result = await DepartmentModel.findAllByBranch(company_id, branch_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateDepartment(id, data) {
        try {
            // Prevent company_id and branch_id from being changed
            delete data.company_id;
            delete data.branch_id;

            // If department_name is being updated, check uniqueness
            if (data.department_name) {
                const department = await DepartmentModel.findById(id);
                if (!department) {
                    return { success: false, message: "Department not found" };
                }
                const existing = await DepartmentModel.findByName(
                    department.company_id,
                    department.branch_id,
                    data.department_name
                );
                if (existing && existing.id !== id) {
                    return { success: false, message: "Department name already exists in this branch" };
                }
            }

            const result = await DepartmentModel.update(id, data);
            if (!result) {
                return { success: false, message: "Department not found" };
            }
            return {
                success: true,
                message: "Department updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateDepartment(id) {
        try {
            const result = await DepartmentModel.deactivate(id);
            if (!result) {
                return { success: false, message: "Department not found" };
            }
            return {
                success: true,
                message: "Department deactivated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteDepartment(id) {
        try {
            const result = await DepartmentModel.delete(id);
            if (!result) {
                return { success: false, message: "Department not found" };
            }
            return {
                success: true,
                message: "Department deleted successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = DepartmentService;