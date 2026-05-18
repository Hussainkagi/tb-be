const EmployeeModel = require("../models/employeeModel");
const CompanyModel = require("../models/companyModel");
const BranchModel = require("../models/branchModel");

const EmployeeService = {

    async getEmployeeById(id) {
        try {
            const result = await EmployeeModel.findById(id);
            if (!result) {
                return { success: false, message: "Employee not found" };
            }
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getEmployeesByCompany(company_id) {
        try {
            const result = await EmployeeModel.getAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getEmployeesByBranch(company_id, branch_id) {
        try {
            const result = await EmployeeModel.getAllByBranch(company_id, branch_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getEmployeesByDepartment(company_id, department_id) {
        try {
            const result = await EmployeeModel.getAllByDepartment(company_id, department_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateEmployee(id, data) {
        try {
            // Prevent these from being changed via a generic update
            delete data.company_id;
            delete data.user_id;
            delete data.employee_code;

            // If branch is being changed, verify it belongs to the same company
            if (data.branch_id) {
                const employee = await EmployeeModel.findById(id);
                if (!employee) {
                    return { success: false, message: "Employee not found" };
                }

                const branch = await BranchModel.findById(data.branch_id);
                if (!branch || branch.company_id !== employee.company_id) {
                    return { success: false, message: "Branch not found or does not belong to this company" };
                }
            }

            const result = await EmployeeModel.update(id, data);
            if (!result) {
                return { success: false, message: "Employee not found" };
            }
            return {
                success: true,
                message: "Employee updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateEmployee(id, data) {
        try {
            // Prevent these from being changed via a generic update
            delete data.company_id;
            delete data.user_id;
            delete data.employee_code;
            delete data.gross_salary;


            if (data.branch_id) {
                const employee = await EmployeeModel.findById(id);
                if (!employee) {
                    return { success: false, message: "Employee not found" };
                }

                const branch = await BranchModel.findById(data.branch_id);
                if (!branch || branch.company_id !== employee.company_id) {
                    return { success: false, message: "Branch not found or does not belong to this company" };
                }
            }

            const result = await EmployeeModel.update(id, data);
            if (!result) {
                return { success: false, message: "Employee not found" };
            }
            return {
                success: true,
                message: "Employee updated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateEmployee(id) {
        try {
            const result = await EmployeeModel.deactivate(id);
            if (!result) {
                return { success: false, message: "Employee not found" };
            }
            return {
                success: true,
                message: "Employee deactivated successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteEmployee(id) {
        try {
            const result = await EmployeeModel.delete(id);
            if (!result) {
                return { success: false, message: "Employee not found" };
            }
            return {
                success: true,
                message: "Employee deleted successfully",
                data: result,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = EmployeeService;